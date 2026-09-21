        expect(chunkCount).toBe(0);
    });

    maybeTest('rejects out-of-range integer metadata before dispatch', async () => {
        let chunkCount = 0;
        await expect(parseTermBankWithWasmColumnChunks(
            textEncoder.encode('[["overflow","overflow","","",2147483648,["definition"],1,""]]'),
            3,
            () => { ++chunkCount; },
        )).rejects.toThrow(/term-bank parser failed/);
        expect(chunkCount).toBe(0);
    });

    maybeTest('bounds and serializes pipelined chunk dispatch', async () => {
        /** @type {number[]} */
        const calls = [];
        const getPlanString = (index) => textDecoder.decode(
            plan.stringsBuffer.subarray(stringOffsets[index], stringOffsets[index] + plan.stringLengths[index]),
        );

        expect(chunk.rowCount).toBe(4);
        expect(chunk.scoreList).toStrictEqual(new Int32Array([-2, 7, -2147483648, 2147483647]));
        expect(chunk.sequenceList).toStrictEqual(new Int32Array([-1, 8, 9, 2147483647]));
        expect(getPlanString(plan.expressionIndexes[0])).toBe('escaped\\value');
        expect(getPlanString(plan.readingIndexes[0])).toBe('reading');
        expect(getPlanString(plan.expressionIndexes[1])).toBe('image');
