import type { Config } from "@jest/types";

const config: Config.InitialOptions = {
    roots: [
        "<rootDir>/test"
    ],
    testMatch: [
        "**/*+(T|.t)est.+(ts|js)"
    ],
    transform: {
        "^.+\\.(ts|js)$": ["ts-jest", {
            tsconfig: "tsconfig.json"
        }]
    },
    collectCoverage: true,
    collectCoverageFrom: [
        "src/**/*.*"
    ],
    coverageReporters: [
        "text",
        "cobertura"
    ]
};

export default config;
