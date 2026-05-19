/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/src'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          jsx: 'react',
          esModuleInterop: true,
          strict: false,
        },
      },
    ],
    // Transform ESM-only packages (d3 etc.) required by @grafana/data
    '^.+\\.js$': 'babel-jest',
  },
  // Allow Jest to transform these ESM-only node_modules
  transformIgnorePatterns: [
    'node_modules/(?!(d3|d3-array|d3-brush|d3-chord|d3-color|d3-contour|d3-delaunay|d3-dispatch|d3-drag|d3-dsv|d3-ease|d3-fetch|d3-force|d3-format|d3-geo|d3-hierarchy|d3-interpolate|d3-path|d3-polygon|d3-quadtree|d3-random|d3-scale|d3-scale-chromatic|d3-selection|d3-shape|d3-time|d3-time-format|d3-timer|d3-transition|d3-zoom|delaunator|internmap|robust-predicates)/)',
  ],
  moduleNameMapper: {
    '\\.(svg|css|png|jpg|gif|woff|woff2|eot|ttf)$': '<rootDir>/src/__mocks__/fileMock.js',
  },
  setupFilesAfterEnv: ['<rootDir>/src/setupTests.ts'],
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/**/*.d.ts', '!src/__mocks__/**', '!src/setupTests.ts'],
  coverageReporters: ['text', 'lcov'],
};
