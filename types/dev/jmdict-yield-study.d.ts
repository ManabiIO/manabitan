/*
 * Copyright (C) 2026  Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

type StudySource = {
    commit: string;
    tree: string;
    productPaths: string[];
    expectedInitialPrefetchFileCount: 0 | 1;
};

export type JmdictYieldStudyManifest = {
    schemaVersion: 1;
    study: string;
    branch: string;
    workflow: string;
    node: string;
    dictionary: 'jmdict';
    blocks: number;
    warmupsPerArm: number;
    measurementDeadlineMinutes: number;
    observationTimeoutSeconds: number;
    arms: {
        A: 'baseline';
        B: 'yield';
        C: 'baseline';
        D: 'yield';
    };
    sources: {
        baseline: StudySource;
        yield: StudySource;
    };
    bundle: {
        file: string;
        sha256: string;
        refs: string[];
    };
    sharedProductInputs: Record<string, string>;
    harnessSha256: Record<string, string>;
    interpretation: {
        timingBoundary: string;
        independentCells: string[];
        control: string;
        comparisons: string;
        bootstrap: string;
        failurePolicy: string;
        memory: string;
    };
};
