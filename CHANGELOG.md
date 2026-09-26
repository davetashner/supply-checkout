# Changelog

## [1.1.0](https://github.com/davetashner/supply-checkout/compare/v1.0.0...v1.1.0) (2026-09-26)


### Features

* build the app with Vite into an artifact and a static bundle ([#20](https://github.com/davetashner/supply-checkout/issues/20)) ([12cedb1](https://github.com/davetashner/supply-checkout/commit/12cedb1c8dd819f4713b74d46a9f92f2c5651b6c))
* create the DynamoDB table and team-scoped data access ([#24](https://github.com/davetashner/supply-checkout/issues/24)) ([015cf06](https://github.com/davetashner/supply-checkout/commit/015cf065f28e8a88a1d42f8f31d112aa6d610b5e))
* harden the data-access module's team scoping ([#26](https://github.com/davetashner/supply-checkout/issues/26)) ([dc03836](https://github.com/davetashner/supply-checkout/commit/dc038362b458edfdade8deeab3f1a484c7c60e6e))
* scaffold the CDK app with cdk-nag and the stack layout ([#18](https://github.com/davetashner/supply-checkout/issues/18)) ([2077bbf](https://github.com/davetashner/supply-checkout/commit/2077bbf20301db43d00ce538d1de3019997da623))


### Bug Fixes

* drop the stray space in CSV filenames for dateless sheets ([#12](https://github.com/davetashner/supply-checkout/issues/12)) ([3ce1935](https://github.com/davetashner/supply-checkout/commit/3ce1935d3d7f20d31ef561104f95f21550c00058))

## 1.0.0 (2026-09-26)


### Features

* supply checkout app ([2092c8e](https://github.com/davetashner/supply-checkout/commit/2092c8ed2821900518489a6db6ab2c454a5c866b))


### Bug Fixes

* add repeat returns to the returned count instead of replacing it ([#8](https://github.com/davetashner/supply-checkout/issues/8)) ([1b37a0e](https://github.com/davetashner/supply-checkout/commit/1b37a0e3697e1b2d000f0a4e704a823598f8f3db))
* iPhone checkout taps, contrast and small-screen layout; add CI gates and test suites ([#7](https://github.com/davetashner/supply-checkout/issues/7)) ([ada8e09](https://github.com/davetashner/supply-checkout/commit/ada8e09a44194cb78c6c582f1004f8cc95b2f5cf))
* keep row editors open when opened with Enter, and match barcodes in any case ([#2](https://github.com/davetashner/supply-checkout/issues/2)) ([04c798a](https://github.com/davetashner/supply-checkout/commit/04c798a033a358d25bbc1d113f2956a4a9be2a8c))
