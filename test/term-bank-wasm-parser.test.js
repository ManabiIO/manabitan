        expect(chunkCount).toBe(0);
    });

    maybeTest.each([2147483648, -2147483649])('rejects out-of-range native sequence %i before dispatch', async (sequence) => {
        let chunkCount = 0;
        await expect(parseTermBankWithWasmColumnChunks(
            textEncoder.encode(JSON.stringify([['overflow', 'overflow', '', '', 0, ['definition'], sequence, '']])),
            3,
            () => { ++chunkCount; },
        )).rejects.toThrow(/term-bank parser failed/);
        expect(chunkCount).toBe(0);
    });

    maybeTest.each([2147483648, -2147483649])('preserves finite score %i outside int32', async (score) => {
        const rows = await parseRows([['wide-score', '', '', '', score, ['definition'], 1, '']]);
        expect(rows).toHaveLength(1);
        expect(rows[0].score).toBe(score);
    });

    maybeTest('bounds and serializes pipelined chunk dispatch', async () => {
        /** @type {number[]} */
        const calls = [];
        const getPlanString = (index) => textDecoder.decode(
            plan.stringsBuffer.subarray(stringOffsets[index], stringOffsets[index] + plan.stringLengths[index]),
        );

        expect(chunk.rowCount).toBe(4);
        expect(chunk.scoreList).toStrictEqual(new Float64Array([-2, 7, -2147483648, 2147483647]));
        expect(chunk.sequenceList).toStrictEqual(new Int32Array([-1, 8, 9, 2147483647]));
        expect(getPlanString(plan.expressionIndexes[0])).toBe('escaped\\value');
        expect(getPlanString(plan.readingIndexes[0])).toBe('reading');
        expect(getPlanString(plan.expressionIndexes[1])).toBe('image');
