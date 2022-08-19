class PretrainedModel {

}


class AutoModelForSeq2SeqLM {
    constructor(encoderSource, initDecoderSource, decoderSource) {
        this.encoderSource = encoderSource;
        this.initDecoderSource = initDecoderSource;
        this.decoderSource = decoderSource;
        this.encoderSession = null;
        this.initDecoderSession = null;
        this.decoderSession = null;
    }
    static async fromPretrained(modelId, modelsPath) {
        const modelIdParts = modelId.split('/');
        const modelName = modelIdParts[modelIdParts.length - 1];
        const suffix = "-quantized";
        const initDecoderUrl = `${modelsPath}/${modelName}-init-decoder${suffix}.onnx`;
        const decoderUrl = `${modelsPath}/${modelName}-decoder${suffix}.onnx`;
        const encoderUrl = `${modelsPath}/${modelName}-encoder${suffix}.onnx`;
        return new T5ForConditionalGeneration(encoderUrl, initDecoderUrl, decoderUrl);
    }
    async ensureLoaded() {
        if (this.encoderSession === null && this.encoderSource) {
            console.log('Loading encoder...');
            this.encoderSession = await ort.InferenceSession.create(this.encoderSource);
        }
        if (this.initDecoderSession === null && this.initDecoderSource) {
            console.log('Loading init decoder...');
            this.initDecoderSession = await ort.InferenceSession.create(this.initDecoderSource);
        }
        if (this.decoderSession === null && this.decoderSource) {
            console.log('Loading decoder...');
            this.decoderSession = await ort.InferenceSession.create(this.decoderSource);
            console.log('Done loading decoder.');
        }
    }
}

class Seq2SeqLMOutput {
    constructor(logits, pastKeyValues, encoderOutputs) {
        this.logits = logits;
        this.pastKeyValues = pastKeyValues;
        this.encoderOutputs = encoderOutputs;
    }
}

class T5ForConditionalGeneration extends AutoModelForSeq2SeqLM {
    constructor(encoderSource, initDecoderSource, decoderSource) {
        super(encoderSource, initDecoderSource, decoderSource);
    }

    async generate(inputTokenIds, maxLength) {
        // attention_mask=token['attention_mask'], num_beams=2
        const startOfDecoderTokenId = 0;
        const endOfDecoderTokenId = 1;
        let encoderOutputs = null;
        let pastKeyValues = null;
        let outputTokenIds = [startOfDecoderTokenId];
        let numOutputTokens = 1;
        const maxOutputTokens = numOutputTokens + maxLength;
        while (numOutputTokens < maxOutputTokens) {
            let output = await this.forward(inputTokenIds, outputTokenIds, encoderOutputs, pastKeyValues);
            pastKeyValues = output.pastKeyValues;
            encoderOutputs = output.encoderOutputs;
            let newTokenId = this.sample(output.logits);
            outputTokenIds.push(newTokenId);
            numOutputTokens++;
            if (newTokenId === endOfDecoderTokenId) {
                break;
            }
        }
        return outputTokenIds;
    }

    sample(logits) {
        let shape = logits.dims;
        let [batchSize, seqLength, vocabSize] = shape;
        let n = batchSize * seqLength * vocabSize;
        let p = Array(vocabSize);
        let startIndex = n - vocabSize;
        let argmaxi = 0;
        let argmax = logits.data[startIndex + argmaxi];
        for (let i = 1; i < vocabSize; i++) {
            let l = logits.data[startIndex + i];
            if (l > argmax) {
                argmaxi = i;
                argmax = l;
            }
        }
        return argmaxi;
    }

    async forward(inputIds, decoderInputIds, encoderOutputs, pastKeyValues) {
        await this.ensureLoaded();

        const inputIdsTensor = new ort.Tensor("int64", new BigInt64Array(inputIds.map(x => BigInt(x))), [1, inputIds.length]);
        const encoderAttentionMaskTensor = new ort.Tensor("int64", new BigInt64Array(inputIds.length).fill(1n), [1, inputIds.length]);
        if (encoderOutputs === null) {
            // console.log("Encoding...");
            const encoderFeeds = {
                "input_ids": inputIdsTensor,
                "attention_mask": encoderAttentionMaskTensor,
            }
            const encoderResults = await this.encoderSession.run(encoderFeeds);
            const encoderHiddenStates = encoderResults.hidden_states;
            encoderOutputs = encoderHiddenStates;
            // console.log("Encoding done.", encoderOutputs);
        }

        const decoderInputIdsTensor = new ort.Tensor("int64", new BigInt64Array(decoderInputIds.map(x => BigInt(x))), [1, decoderInputIds.length]);
        // const decoderAttentionMaskTensor = new ort.Tensor("int64", new BigInt64Array(decoderInputIds.length).fill(1n), [1, decoderInputIds.length]);
        const decoderFeeds = {
            "input_ids": decoderInputIdsTensor,
            "encoder_attention_mask": encoderAttentionMaskTensor,
            "encoder_hidden_states": encoderOutputs,
        };
        let logits = null;

        if (pastKeyValues === null) {
            // console.log("Init Decoding...");
            const initDecoderResults = await this.initDecoderSession.run(decoderFeeds);
            logits = initDecoderResults.logits;
            pastKeyValues = this.getPastKeyValues(this.initDecoderSession.outputNames.slice(1), initDecoderResults);
            // console.log("Init Decoding done.", logits, pastKeyValues);
        }
        else {
            // console.log("Decoding...");
            for (const [k, v] of pastKeyValues) {
                decoderFeeds[k] = v;
            }
            const decoderResults = await this.decoderSession.run(decoderFeeds);
            logits = decoderResults.logits;
            pastKeyValues = this.getPastKeyValues(this.decoderSession.outputNames.slice(1), decoderResults);
            // console.log("Decoding done.", logits, pastKeyValues);
        }
        return new Seq2SeqLMOutput(logits, pastKeyValues, encoderOutputs);
    }

    getPastKeyValues(pkvNames, decoderResults) {
        const pkvs = [];
        for (const i in pkvNames) {
            const k = pkvNames[i];
            const v = decoderResults[k];
            pkvs.push([`pkv_${i}`, v]);
        }
        return pkvs;
    }
}

