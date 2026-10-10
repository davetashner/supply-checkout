# Changelog

## [1.11.0](https://github.com/davetashner/supply-checkout/compare/v1.10.0...v1.11.0) (2026-10-10)


### Features

* store and serve profile photos (API and bucket) ([#723](https://github.com/davetashner/supply-checkout/issues/723)) ([a2ad35a](https://github.com/davetashner/supply-checkout/commit/a2ad35a5e75ae9aa97eae2691b5d72c2320edb06))
* upload, crop and show profile photos ([#722](https://github.com/davetashner/supply-checkout/issues/722)) ([099b745](https://github.com/davetashner/supply-checkout/commit/099b7455124f7f14868a02d92e2031990a983fd3))


### Bug Fixes

* don't refresh again when a call's token was already replaced ([#730](https://github.com/davetashner/supply-checkout/issues/730)) ([05091ea](https://github.com/davetashner/supply-checkout/commit/05091ea16f9d8f571bde23169ca0d7dfc7822add))
* keep the changed password's screen when a sign-in screen finishes drawing later ([#728](https://github.com/davetashner/supply-checkout/issues/728)) ([e303a9f](https://github.com/davetashner/supply-checkout/commit/e303a9f3c6b22c08ba9308c0324f9d179771af61))
* require dynamodb:Select on the remaining IfExists GetItem grants ([#725](https://github.com/davetashner/supply-checkout/issues/725)) ([87a5fbe](https://github.com/davetashner/supply-checkout/commit/87a5fbef7028ea03075e95c4dcee2c62915709e1))

## [1.10.0](https://github.com/davetashner/supply-checkout/compare/v1.9.0...v1.10.0) (2026-10-09)


### Features

* a link preview for the home page ([#488](https://github.com/davetashner/supply-checkout/issues/488)) ([528d0de](https://github.com/davetashner/supply-checkout/commit/528d0ded3861590191e957a7cfb1b8ccba9c6547))
* add a receipt step to the first-run checklist ([#703](https://github.com/davetashner/supply-checkout/issues/703)) ([bda5e77](https://github.com/davetashner/supply-checkout/commit/bda5e778d66ec466ebcf5a640e1aae124a9abed3))
* add the journeys stack: test mail subdomain, SES inbound, buckets and role ([#564](https://github.com/davetashner/supply-checkout/issues/564)) ([5887453](https://github.com/davetashner/supply-checkout/commit/5887453368cad837a3a24e5e63fe3323822de9e6))
* alarm on the operator page's distribution and router at P2 ([#708](https://github.com/davetashner/supply-checkout/issues/708)) ([d071ca9](https://github.com/davetashner/supply-checkout/commit/d071ca9a7534de68024c11f76f0277759ed6131c))
* alert when the cost alerts are changed outside a deploy ([#645](https://github.com/davetashner/supply-checkout/issues/645)) ([102d5d0](https://github.com/davetashner/supply-checkout/commit/102d5d04875bf2e60c498db04e6bafd31dedd241))
* **billing:** warn and close lapsed teams for deletion ([#465](https://github.com/davetashner/supply-checkout/issues/465)) ([8b5683a](https://github.com/davetashner/supply-checkout/commit/8b5683a42b573925d41d7c95dc19ec596e4795f6))
* cap trial receipt reads across the account and alert on Bedrock spend ([#553](https://github.com/davetashner/supply-checkout/issues/553)) ([0ec8d39](https://github.com/davetashner/supply-checkout/commit/0ec8d39d35b5e2ea369ba02016f88de3ecabe45e))
* change your password from the Account screen ([#609](https://github.com/davetashner/supply-checkout/issues/609)) ([3587c55](https://github.com/davetashner/supply-checkout/commit/3587c555f5fe8db306847f9e02ec8f5908e9bcf7))
* comp a team for N months, with a Stripe discount for paying teams ([#471](https://github.com/davetashner/supply-checkout/issues/471)) ([8d63bd1](https://github.com/davetashner/supply-checkout/commit/8d63bd13d04185475d280a38aaee24735d7bcf14))
* distinct clips with real names, slower playback and the working-proposal price ([#491](https://github.com/davetashner/supply-checkout/issues/491)) ([33e8407](https://github.com/davetashner/supply-checkout/commit/33e84077bdb621549cdbe5896fc887f1fc4161f8))
* give security notices the support address and a recovery path ([#651](https://github.com/davetashner/supply-checkout/issues/651)) ([4d706de](https://github.com/davetashner/supply-checkout/commit/4d706de697541d34f45b63a74ee86395fa5cb4c8))
* help people reset a password for an address with no account ([#628](https://github.com/davetashner/supply-checkout/issues/628)) ([283b5dc](https://github.com/davetashner/supply-checkout/commit/283b5dc4aa8305526b4b3e5714273767f30af892))
* keep each user's What's New preferences on the server ([#619](https://github.com/davetashner/supply-checkout/issues/619)) ([1e84a2c](https://github.com/davetashner/supply-checkout/commit/1e84a2cd08da9754732ac15e5b7db19949d4a86f))
* keep the first-run checklist's progress on the server ([#705](https://github.com/davetashner/supply-checkout/issues/705)) ([066a913](https://github.com/davetashner/supply-checkout/commit/066a9130e8de67e2d64447a31819c9f24c0129b3))
* let owners of a closed team see and download invoices until it's deleted ([#704](https://github.com/davetashner/supply-checkout/issues/704)) ([fcc0ce0](https://github.com/davetashner/supply-checkout/commit/fcc0ce0d991b777852cec56558380e5b2e73fcca))
* load open and recent projects at start, older ones on demand ([#625](https://github.com/davetashner/supply-checkout/issues/625)) ([ec75a9f](https://github.com/davetashner/supply-checkout/commit/ec75a9f9f025bd039b3f4ada1ae5f91dee38d90d))
* low-stock alerts with a shared acknowledgment ([#526](https://github.com/davetashner/supply-checkout/issues/526)) ([dd3ae65](https://github.com/davetashner/supply-checkout/commit/dd3ae659c0f62ad69c73b441c7a9a1656a8886a0))
* mark low items ordered with a quantity and date ([#539](https://github.com/davetashner/supply-checkout/issues/539)) ([0977b9c](https://github.com/davetashner/supply-checkout/commit/0977b9cac21e846a1c7e654b8f206478b2e3f412))
* mark test accounts and teams by the test mail subdomain and keep them out of business metrics ([#567](https://github.com/davetashner/supply-checkout/issues/567)) ([2a80fa0](https://github.com/davetashner/supply-checkout/commit/2a80fa0333b4ca42e515e755b2d996e6179fa031))
* marketing home page built from the journey clips ([#483](https://github.com/davetashner/supply-checkout/issues/483)) ([4b467f3](https://github.com/davetashner/supply-checkout/commit/4b467f372a0331b3747167f293cd4487aec18099))
* operator web admin page on its own origin (ops.) ([#477](https://github.com/davetashner/supply-checkout/issues/477)) ([2ef6299](https://github.com/davetashner/supply-checkout/commit/2ef62990b60c24e53a7fb6d9c703b0c07ee79aed))
* optional brand on products ([#525](https://github.com/davetashner/supply-checkout/issues/525)) ([2f06cc0](https://github.com/davetashner/supply-checkout/commit/2f06cc0b5953d330a423cc33a1590b35089a4b22))
* projects-rename backfill mode ([#510](https://github.com/davetashner/supply-checkout/issues/510)) ([adfead4](https://github.com/davetashner/supply-checkout/commit/adfead4a9232d6a3ace8fa46790d51cf6da6477f))
* re-record the home page clips with Projects and a photo avatar ([#580](https://github.com/davetashner/supply-checkout/issues/580)) ([223e3d4](https://github.com/davetashner/supply-checkout/commit/223e3d48c4db881ce92b6d04cc3b04a38de70266))
* refuse sessions that began before a password reset ([#652](https://github.com/davetashner/supply-checkout/issues/652)) ([36f9dc0](https://github.com/davetashner/supply-checkout/commit/36f9dc093de753c565a0d3af0a9f47c8fe4b2e08))
* remove the captions drawn over the home page's clips ([#492](https://github.com/davetashner/supply-checkout/issues/492)) ([9d8ffad](https://github.com/davetashner/supply-checkout/commit/9d8ffad9a19ea6c8f12254cf3b050e2e5f027f8b))
* rename sheets to projects in the app ([#511](https://github.com/davetashner/supply-checkout/issues/511)) ([d9ce2e0](https://github.com/davetashner/supply-checkout/commit/d9ce2e0b7a6280472bf79a3b5ebd8d772c463817))
* rename sheets to projects in the backend ([#519](https://github.com/davetashner/supply-checkout/issues/519)) ([6a25deb](https://github.com/davetashner/supply-checkout/commit/6a25deb786f805eee8a41c4e5b9b95af796648e8))
* reorder levels in the inventory CSV import and export ([#541](https://github.com/davetashner/supply-checkout/issues/541)) ([be4a054](https://github.com/davetashner/supply-checkout/commit/be4a0545d66edd3b6066627fa64c293b4cae52e9))
* say why a team is read-only for billing, with what to do next ([#608](https://github.com/davetashner/supply-checkout/issues/608)) ([17bc56d](https://github.com/davetashner/supply-checkout/commit/17bc56d17e282d55e910c5e6a175c8a680e3a6d5))
* scan barcodes live with the camera ([#538](https://github.com/davetashner/supply-checkout/issues/538)) ([053b6a0](https://github.com/davetashner/supply-checkout/commit/053b6a0d44e9c8a9a82a72ca5c50c97f3a841c3f))
* send a welcome email once to every new account ([#480](https://github.com/davetashner/supply-checkout/issues/480)) ([61d9e2b](https://github.com/davetashner/supply-checkout/commit/61d9e2ba63473738c3f3562fddbb7e99f45405a4))
* server accepts projects and sheets ([#513](https://github.com/davetashner/supply-checkout/issues/513)) ([a4f67e5](https://github.com/davetashner/supply-checkout/commit/a4f67e59f26b1bfc7973e6356ce7c4cd816bfa42))
* show a What's New banner with the last 14 days' changes ([#622](https://github.com/davetashner/supply-checkout/issues/622)) ([e42e75e](https://github.com/davetashner/supply-checkout/commit/e42e75efc3350cd71c1082159b0baaea7991c141))
* show members' names on the members screen ([#666](https://github.com/davetashner/supply-checkout/issues/666)) ([0b8e700](https://github.com/davetashner/supply-checkout/commit/0b8e70074ded58fa81aa1a8dc0198a0ec89cc81a))
* show who is signed in, with their role, on the team bar ([#605](https://github.com/davetashner/supply-checkout/issues/605)) ([58eda98](https://github.com/davetashner/supply-checkout/commit/58eda989c9808512617c5d5d8814d95b3d45c2dc))
* sign out everywhere and send a notice after a password reset ([#640](https://github.com/davetashner/supply-checkout/issues/640)) ([ffa0276](https://github.com/davetashner/supply-checkout/commit/ffa0276b27c8796c43faf0fee2ac98e89f05b9c5))
* tag background jobs' metrics as test for test teams ([#576](https://github.com/davetashner/supply-checkout/issues/576)) ([343ffe9](https://github.com/davetashner/supply-checkout/commit/343ffe97d423e1031ba91bb0b28f5a0b706a4acc))


### Bug Fixes

* cancel and void the unpaid subscription an unpaid team's resubscription replaces ([#697](https://github.com/davetashner/supply-checkout/issues/697)) ([6b38db8](https://github.com/davetashner/supply-checkout/commit/6b38db8103ca0955cfa9d0d4d0cddfacce0c7e32))
* carry company equipment fields through the artifact import ([#644](https://github.com/davetashner/supply-checkout/issues/644)) ([a8ff08d](https://github.com/davetashner/supply-checkout/commit/a8ff08db965e76dd728a2fef7059d20fdb7191c2))
* change equipment counts only through the checkout, return and lost commands ([#680](https://github.com/davetashner/supply-checkout/issues/680)) ([13ae74d](https://github.com/davetashner/supply-checkout/commit/13ae74d77e0da7043afa929b14e2b1e100ffca6b))
* condition the entitlement check's fix on the team's version ([#689](https://github.com/davetashner/supply-checkout/issues/689)) ([cfa693c](https://github.com/davetashner/supply-checkout/commit/cfa693c4f1144facfea2e6d3ddc97f2114e3b57a))
* deny the data role writes to a team's billing attributes ([#706](https://github.com/davetashner/supply-checkout/issues/706)) ([117b612](https://github.com/davetashner/supply-checkout/commit/117b612ddcd241d9ec4889b88d2f06bfbf7e5edc))
* don't fetch a deleted document for a late live event, and handle the RUM credentials failure ([#665](https://github.com/davetashner/supply-checkout/issues/665)) ([f41a9f3](https://github.com/davetashner/supply-checkout/commit/f41a9f399afc48c3f104e45f617ea96431677121))
* don't stall the live scanner on a camera with no picture, or draw a stopped one ([#552](https://github.com/davetashner/supply-checkout/issues/552)) ([ceb1ece](https://github.com/davetashner/supply-checkout/commit/ceb1eceacb08a649a20e2aa831ec4d775bd8f03a))
* don't update the members screen's seat count after the screen has closed ([#678](https://github.com/davetashner/supply-checkout/issues/678)) ([baf043e](https://github.com/davetashner/supply-checkout/commit/baf043ec7d566a86002583e0410aca512eb994da))
* drop the SES sandbox allowance now that production access is granted ([#581](https://github.com/davetashner/supply-checkout/issues/581)) ([033c1f4](https://github.com/davetashner/supply-checkout/commit/033c1f4cec2e9bcd71332eb8f473803c379b81e0))
* guard CSV cells against formulas behind spaces and lookalike characters ([#672](https://github.com/davetashner/supply-checkout/issues/672)) ([088b0a5](https://github.com/davetashner/supply-checkout/commit/088b0a586c8edfadd9d37477f9a62128a049a520))
* hide the home page's clip descriptions from sight ([#487](https://github.com/davetashner/supply-checkout/issues/487)) ([951fe53](https://github.com/davetashner/supply-checkout/commit/951fe538dae8f39132a3ce65a4c64c29fa39cb8f))
* hold lapsed teams for Checkout without Stripe calls, and flag ones held too long ([#620](https://github.com/davetashner/supply-checkout/issues/620)) ([a683641](https://github.com/davetashner/supply-checkout/commit/a683641dce7d322dc37b70a382d54ca1510202d9))
* hold product prices to the money rule in createProduct and updateProduct ([#688](https://github.com/davetashner/supply-checkout/issues/688)) ([3ee2f6a](https://github.com/davetashner/supply-checkout/commit/3ee2f6aac6748d56aa0a967f06552ad9ceab06d1))
* keep low-stock acknowledgments right under concurrent changes ([#535](https://github.com/davetashner/supply-checkout/issues/535)) ([0ac25d9](https://github.com/davetashner/supply-checkout/commit/0ac25d935945ac9c3263ca26b3a2d33ce4dbcb2e))
* let the app's mail roles send to verified recipients while SES is in the sandbox ([#493](https://github.com/davetashner/supply-checkout/issues/493)) ([a54a8f1](https://github.com/davetashner/supply-checkout/commit/a54a8f1f1c8fb1689ac7374da45a6b8b5643eb77))
* match the cdk-nag acknowledgement for the SES sandbox grant when the account is known ([#497](https://github.com/davetashner/supply-checkout/issues/497)) ([430688f](https://github.com/davetashner/supply-checkout/commit/430688fbc33e04c90bb5b8ba6dc4ed913a6219b5))
* neutral signed-out-everywhere message, counted record failure, fresh reset cache ([#658](https://github.com/davetashner/supply-checkout/issues/658)) ([b29ff37](https://github.com/davetashner/supply-checkout/commit/b29ff376a086670b27370728d387ac48b30ef121))
* read rotated and hard-to-scan barcodes from photos ([#502](https://github.com/davetashner/supply-checkout/issues/502)) ([9c9587a](https://github.com/davetashner/supply-checkout/commit/9c9587a8a4d42f4483cec60513a72f70545bb78b))
* read rotated and small barcodes and reject bad check digits ([#530](https://github.com/davetashner/supply-checkout/issues/530)) ([0723989](https://github.com/davetashner/supply-checkout/commit/072398981c6f45b29d36981a3ce93a6c6059a0af))
* refuse a new equipment line with something out on a document write ([#690](https://github.com/davetashner/supply-checkout/issues/690)) ([af84a43](https://github.com/davetashner/supply-checkout/commit/af84a435c67d20b12edc475815c42d4cfc4b0c6d))
* refuse a new project line whose kind disagrees with its item's ([#695](https://github.com/davetashner/supply-checkout/issues/695)) ([62cc631](https://github.com/davetashner/supply-checkout/commit/62cc631b75b8236c006410b70043929ec258718b))
* refuse invisible characters in project clients and team names ([#550](https://github.com/davetashner/supply-checkout/issues/550)) ([e4451c5](https://github.com/davetashner/supply-checkout/commit/e4451c51176962cd1e939499413bcea90ecafc1c))
* refuse invisible direction and control characters in item names and brands ([#540](https://github.com/davetashner/supply-checkout/issues/540)) ([d06ed17](https://github.com/davetashner/supply-checkout/commit/d06ed174e0e743f87c7cc50e0b15d74cb3bf9d0c))
* refuse non-object project lines and removing equipment lines with items out ([#673](https://github.com/davetashner/supply-checkout/issues/673)) ([61e5e28](https://github.com/davetashner/supply-checkout/commit/61e5e28986cad774da8bbc7d1265a413f4ba6a91))
* render the password forms' username field visually hidden, not display:none ([#662](https://github.com/davetashner/supply-checkout/issues/662)) ([104d007](https://github.com/davetashner/supply-checkout/commit/104d0075555e8cc178507e6bfc57bfaf92c8a4ea))
* require a projection on the purge role's GetItem ([#611](https://github.com/davetashner/supply-checkout/issues/611)) ([264675c](https://github.com/davetashner/supply-checkout/commit/264675cf87348ce490379f1a8ce794233225faac))
* require a projection on the two-step, notice-address, proven-email and lapse-record reads ([#657](https://github.com/davetashner/supply-checkout/issues/657)) ([81b3b65](https://github.com/davetashner/supply-checkout/commit/81b3b65192fd3f0148926ca098f46dcb5b237f31))
* retry a re-list asked for while another one failed ([#639](https://github.com/davetashner/supply-checkout/issues/639)) ([298e5ac](https://github.com/davetashner/supply-checkout/commit/298e5acbccf50e691365e0a0766b768bd665ed40))
* show a newly joined team in the switcher at once, and say when an invite link is incomplete ([#663](https://github.com/davetashner/supply-checkout/issues/663)) ([75179d7](https://github.com/davetashner/supply-checkout/commit/75179d7354675f41ffdd79c8bd542b09f85b8dd4))
* show equipment counts read-only and explain a refused removal ([#681](https://github.com/davetashner/supply-checkout/issues/681)) ([d5b4fd6](https://github.com/davetashner/supply-checkout/commit/d5b4fd647a79c6400deca7401c4e6be3642c2683))
* stamp a project's closedAt on the server when it's finished ([#650](https://github.com/davetashner/supply-checkout/issues/650)) ([5786e51](https://github.com/davetashner/supply-checkout/commit/5786e5105238b35b1fa7c7d89749a20096e31157))
* stop a sender suppressing another customer's seat sync via dedupe IDs ([#664](https://github.com/davetashner/supply-checkout/issues/664)) ([53549c7](https://github.com/davetashner/supply-checkout/commit/53549c7a93130260b8011b45948523728691ec7b))
* stop the camera if the page is hidden while it starts ([#544](https://github.com/davetashner/supply-checkout/issues/544)) ([615ea84](https://github.com/davetashner/supply-checkout/commit/615ea84cbe36ebc05dd5f268c993dd16df57ea4e))

## [1.9.0](https://github.com/davetashner/supply-checkout/compare/v1.8.0...v1.9.0) (2026-10-02)


### Features

* add a prod restore drill script ([#428](https://github.com/davetashner/supply-checkout/issues/428)) ([6014e43](https://github.com/davetashner/supply-checkout/commit/6014e434d40361367a474c9d11a936422d97876a))
* **billing:** make lapsed trials and overdue payments read-only ([#460](https://github.com/davetashner/supply-checkout/issues/460)) ([3d14596](https://github.com/davetashner/supply-checkout/commit/3d145966869ecdf6e5c946c33240e33a4d9a2402))
* operators see each team's receipt reads and estimated cost ([#442](https://github.com/davetashner/supply-checkout/issues/442)) ([8e2240c](https://github.com/davetashner/supply-checkout/commit/8e2240c3f51166cf870485f5f7063cec49a8ac29))
* per-user receipt rate limits and per-plan receipt allowances ([#433](https://github.com/davetashner/supply-checkout/issues/433)) ([0eab535](https://github.com/davetashner/supply-checkout/commit/0eab5354ed98d3faa3390d86a168cf0c3d221674))
* read receipts in the web app with Claude on Bedrock ([#417](https://github.com/davetashner/supply-checkout/issues/417)) ([87066d6](https://github.com/davetashner/supply-checkout/commit/87066d6ad44f91fa55eb0708e75e7df42bc7c5c1))
* read receipts with Claude on Bedrock (receipts endpoint) ([#411](https://github.com/davetashner/supply-checkout/issues/411)) ([b514a37](https://github.com/davetashner/supply-checkout/commit/b514a3712c62c978cd16c5134e09a8d10a924452))
* route support@ mail to the owner's inbox ([#431](https://github.com/davetashner/supply-checkout/issues/431)) ([bd6f918](https://github.com/davetashner/supply-checkout/commit/bd6f918faa4153cbfb1df903c8cc7bc28fbd9211))
* search returned sheets and group them by year and month ([#425](https://github.com/davetashner/supply-checkout/issues/425)) ([eb41977](https://github.com/davetashner/supply-checkout/commit/eb419778a09b2279dd6c232da5d6273466912267))
* show receipt scans left and the limit messages in the web app ([#437](https://github.com/davetashner/supply-checkout/issues/437)) ([a70aca0](https://github.com/davetashner/supply-checkout/commit/a70aca098075cfcb5922a5b442e832feae04534b))


### Bug Fixes

* stack Finished Return's equipment steppers on narrow phones ([#422](https://github.com/davetashner/supply-checkout/issues/422)) ([e1dc8e7](https://github.com/davetashner/supply-checkout/commit/e1dc8e728409f3e1b3fa23aa0720f85f186be49d))

## [1.8.0](https://github.com/davetashner/supply-checkout/compare/v1.7.1...v1.8.0) (2026-10-01)


### Features

* add AWS Budgets and cost anomaly alerts ([#384](https://github.com/davetashner/supply-checkout/issues/384)) ([10efcf9](https://github.com/davetashner/supply-checkout/commit/10efcf9694a16b79bafac7bff6a8660d8815deed))
* ask about equipment still out at Finished Return ([#399](https://github.com/davetashner/supply-checkout/issues/399)) ([3048f95](https://github.com/davetashner/supply-checkout/commit/3048f95fd7fda04077e2763510fa61a85137f775))
* bill equipment bought for a client and set its markup ([#401](https://github.com/davetashner/supply-checkout/issues/401)) ([f348a85](https://github.com/davetashner/supply-checkout/commit/f348a8505804b28f0182dc9018c07d1e1f9bda4e))
* company equipment and the equipment markup on the server ([#385](https://github.com/davetashner/supply-checkout/issues/385)) ([d094753](https://github.com/davetashner/supply-checkout/commit/d0947533fdf67332a32407e098bb93480fad1c98))
* company equipment in inventory and on sheets ([#395](https://github.com/davetashner/supply-checkout/issues/395)) ([52a1f43](https://github.com/davetashner/supply-checkout/commit/52a1f43ccf059b1e08b5c032dc2d9becc6b5571f))
* quick take onto the ad hoc sheet and move its lines on the server ([#405](https://github.com/davetashner/supply-checkout/issues/405)) ([4fbfc58](https://github.com/davetashner/supply-checkout/commit/4fbfc58fd6e594337afa235c4ba4ed252114ef11))
* say closing an annual plan doesn't refund unused months ([#383](https://github.com/davetashner/supply-checkout/issues/383)) ([a6d496d](https://github.com/davetashner/supply-checkout/commit/a6d496d2dc6eeeaf56f164b977dce19a484adde6))
* take supplies without a job sheet, and return them from anywhere ([#408](https://github.com/davetashner/supply-checkout/issues/408)) ([e978cad](https://github.com/davetashner/supply-checkout/commit/e978cadc39c57d51e0abb931d51b59f4e66e4732))
* trace typed prices and keep equipment fields server-owned ([#388](https://github.com/davetashner/supply-checkout/issues/388)) ([1708ce0](https://github.com/davetashner/supply-checkout/commit/1708ce075c58108d94a29a847ff7dbcd79fd44c0))


### Bug Fixes

* purge a closed team on schedule even when Stripe is down ([#386](https://github.com/davetashner/supply-checkout/issues/386)) ([e082cb3](https://github.com/davetashner/supply-checkout/commit/e082cb35cb0241e526f26d09a34bbf5b1b28255d))

## [1.7.1](https://github.com/davetashner/supply-checkout/compare/v1.7.0...v1.7.1) (2026-10-01)


### Bug Fixes

* alert P2 on any change to who the alarms reach ([#368](https://github.com/davetashner/supply-checkout/issues/368)) ([2496d92](https://github.com/davetashner/supply-checkout/commit/2496d92aa677be27ba063958d024b0e9b65ffbbb))
* purge a held closed team 14 days after its deletion date ([#370](https://github.com/davetashner/supply-checkout/issues/370)) ([6c3a7ea](https://github.com/davetashner/supply-checkout/commit/6c3a7eaddef25bc53ee95739cf61ea6d4d047247))
* say what happens to billing in the reopen email, and read the team once per seat sync ([#362](https://github.com/davetashner/supply-checkout/issues/362)) ([830d561](https://github.com/davetashner/supply-checkout/commit/830d561e2877ef8299f8d9949449fcd274214fac))

## [1.7.0](https://github.com/davetashner/supply-checkout/compare/v1.6.0...v1.7.0) (2026-10-01)


### Features

* show a team's Stripe subscription and invoices to operators ([#348](https://github.com/davetashner/supply-checkout/issues/348)) ([5f57652](https://github.com/davetashner/supply-checkout/commit/5f57652033a0d794bc299ad7f8f572d72acd9510))


### Bug Fixes

* alarm on closed-team subscriptions Stripe doesn't have, and stop permanent failures starving the purge's cancel list ([#327](https://github.com/davetashner/supply-checkout/issues/327)) ([c17cc3b](https://github.com/davetashner/supply-checkout/commit/c17cc3b31f9484f450da70f1ef72e36c994b7103))
* alarm on the pre token generation trigger's errors and throttles ([#358](https://github.com/davetashner/supply-checkout/issues/358)) ([68fddac](https://github.com/davetashner/supply-checkout/commit/68fddacf0b9c10eef811d80346774ec9c7e1a803))
* alert on ops branding calls that name only the branding ID ([#326](https://github.com/davetashner/supply-checkout/issues/326)) ([a190077](https://github.com/davetashner/supply-checkout/commit/a19007730a0ff872de90f1c4345f433bd8f010f9))
* alert when the operator pool is deleted, loses deletion protection, gains a domain or loses its branding ([#311](https://github.com/davetashner/supply-checkout/issues/311)) ([9841bd6](https://github.com/davetashner/supply-checkout/commit/9841bd6aa5ce9145ad537e2e2554dc00eb7b4d6e))
* alert when the operator pool's client, domain or identity providers are deleted or changed ([#296](https://github.com/davetashner/supply-checkout/issues/296)) ([53734dc](https://github.com/davetashner/supply-checkout/commit/53734dc332f0181c943d5de014247d2e11f1f313))
* alert when the SSM parameters behind the API's authorizers are changed ([#334](https://github.com/davetashner/supply-checkout/issues/334)) ([61f47f8](https://github.com/davetashner/supply-checkout/commit/61f47f88691450c88ebd525138208a9af9bde037))
* alert when the SSM parameters the operator alerts read are changed ([#330](https://github.com/davetashner/supply-checkout/issues/330)) ([de06427](https://github.com/davetashner/supply-checkout/commit/de06427cc1f9a10404be79883f9dc5f93feb3c49))
* don't let a stale item form undo someone else's stock change ([#322](https://github.com/davetashner/supply-checkout/issues/322)) ([16dfd3c](https://github.com/davetashner/supply-checkout/commit/16dfd3ccf802e397aa316d3e088399de540cbc30))
* hold back the purge of closed teams set aside, and alarm on Stripe customers already deleted ([#340](https://github.com/davetashner/supply-checkout/issues/340)) ([f147ae5](https://github.com/davetashner/supply-checkout/commit/f147ae5d50ce79515943650592391760b0888cea))
* keep alerting while closed teams are set aside, and set aside not-found and permanent Stripe errors ([#335](https://github.com/davetashner/supply-checkout/issues/335)) ([39c69f2](https://github.com/davetashner/supply-checkout/commit/39c69f2573dfa620c8c27441a4901a5cc6c41fd2))
* let someone stop counting an item in the web build ([#316](https://github.com/davetashner/supply-checkout/issues/316)) ([9263db6](https://github.com/davetashner/supply-checkout/commit/9263db684b4f6723fede067dddb735b00c0ff0d1))
* make the item editor's storage count and pack size clear ([#292](https://github.com/davetashner/supply-checkout/issues/292)) ([1162729](https://github.com/davetashner/supply-checkout/commit/116272944fc93dde37cc22b2e594b412a2cf1caf))
* match the deploy role's trust on GitHub's immutable owner and repository IDs ([#344](https://github.com/davetashner/supply-checkout/issues/344)) ([fae69ba](https://github.com/davetashner/supply-checkout/commit/fae69ba6772e445684a15e6adebf329c8bd33994))
* record each account's notice address before its email can change ([#312](https://github.com/davetashner/supply-checkout/issues/312)) ([264232a](https://github.com/davetashner/supply-checkout/commit/264232aa9237e0054529cb33a3896d6324918efc))
* refuse billing for a session older than two-step sign-in ([#301](https://github.com/davetashner/supply-checkout/issues/301)) ([50a5c0c](https://github.com/davetashner/supply-checkout/commit/50a5c0c9c5cbc70601d1961d21f4d58fb377867c))
* resume the Stripe subscription when a team is reopened ([#346](https://github.com/davetashner/supply-checkout/issues/346)) ([4e77c78](https://github.com/davetashner/supply-checkout/commit/4e77c78ef383f90a1e20b75563defbcfad2dd4dc))

## [1.6.0](https://github.com/davetashner/supply-checkout/compare/v1.5.0...v1.6.0) (2026-10-01)


### Features

* email the account when its password, two-step sign-in or email is changed directly against Cognito ([#278](https://github.com/davetashner/supply-checkout/issues/278)) ([0965d0a](https://github.com/davetashner/supply-checkout/commit/0965d0aeccc5bf4065a64cd4defca78c82399136))

## [1.5.0](https://github.com/davetashner/supply-checkout/compare/v1.4.0...v1.5.0) (2026-10-01)


### Features

* alarm on RUM event surges and on security notices not sent ([#273](https://github.com/davetashner/supply-checkout/issues/273)) ([0d2b58d](https://github.com/davetashner/supply-checkout/commit/0d2b58df76cba31d7c54f5de26b2f5c1738889c0))
* alert on operators deleted or locked out and on trail bucket and key changes ([#256](https://github.com/davetashner/supply-checkout/issues/256)) ([c730294](https://github.com/davetashner/supply-checkout/commit/c730294d5fad9acfadb58981f476e7f66277fea8))
* email the account when a password is set or two-step sign-in is turned on ([#257](https://github.com/davetashner/supply-checkout/issues/257)) ([e01ded2](https://github.com/davetashner/supply-checkout/commit/e01ded2a22dda6e8701fa463aaa5de377da303ed))
* shrink receipt photos on the device before they're read ([#258](https://github.com/davetashner/supply-checkout/issues/258)) ([c54a759](https://github.com/davetashner/supply-checkout/commit/c54a75992c27333d170d01c116f3dfdcff0e20f9))


### Bug Fixes

* alarm when a closed team is charged for a period after it closed ([#275](https://github.com/davetashner/supply-checkout/issues/275)) ([929c962](https://github.com/davetashner/supply-checkout/commit/929c962de8260597e08e46110fba9f103adeb627))
* alert on RemovePermission on the watches and lock the group watch's log writes to it ([#259](https://github.com/davetashner/supply-checkout/issues/259)) ([4b1c9a2](https://github.com/davetashner/supply-checkout/commit/4b1c9a22774a1bffc65df9d67d1273a611cef941))
* deflake the operators Ctrl-C test by waiting for the CLI to run ([#274](https://github.com/davetashner/supply-checkout/issues/274)) ([05da09f](https://github.com/davetashner/supply-checkout/commit/05da09f20feada8b9ae53fb885c5d3b8b05e5fd0))
* flag a closed team reopened while the billing worker ends its subscription ([#271](https://github.com/davetashner/supply-checkout/issues/271)) ([7954a2f](https://github.com/davetashner/supply-checkout/commit/7954a2f693e946c4a7a1b639dfd261ff1dd344f8))
* land an open beads export PR instead of opening a second one ([#272](https://github.com/davetashner/supply-checkout/issues/272)) ([07ead31](https://github.com/davetashner/supply-checkout/commit/07ead3175ae8c2e5fbb6e79cd740c72835d33072))
* limit the receipt-import line price to the money bounds ([#260](https://github.com/davetashner/supply-checkout/issues/260)) ([e0b294d](https://github.com/davetashner/supply-checkout/commit/e0b294d932d6936e0bcb2bdf139d5d13a2fc9977))
* retry the squash merge in npm run land after a transient GitHub error ([#270](https://github.com/davetashner/supply-checkout/issues/270)) ([88cd728](https://github.com/davetashner/supply-checkout/commit/88cd7282a822a0bb23c01b7daf3de137271990c5))
* stop npm run land hanging forever when the PR's CI fails ([#263](https://github.com/davetashner/supply-checkout/issues/263)) ([4cf9d7a](https://github.com/davetashner/supply-checkout/commit/4cf9d7a1c4888d4aef7c9aeb08619df803f54aea))

## [1.4.0](https://github.com/davetashner/supply-checkout/compare/v1.3.0...v1.4.0) (2026-09-29)


### Features

* add the GitHub Actions OIDC deploy role for prod ([#222](https://github.com/davetashner/supply-checkout/issues/222)) ([ea6d60e](https://github.com/davetashner/supply-checkout/commit/ea6d60e980e51aa718ba013d2c2ff41da780abff))
* alarm when the web app is down: CloudFront 5xx rate and router errors ([#192](https://github.com/davetashner/supply-checkout/issues/192)) ([280816c](https://github.com/davetashner/supply-checkout/commit/280816c5b29b89a8241aa87177fe70c8f178f873))
* cancel a closed team's Stripe subscription and delete its customer at purge ([#210](https://github.com/davetashner/supply-checkout/issues/210)) ([bffb3f5](https://github.com/davetashner/supply-checkout/commit/bffb3f5f2bb5e95cfe65548ee8e9a5d516a647a5))
* check team entitlements against Stripe nightly and add the billing DLQ replay runbook ([#229](https://github.com/davetashner/supply-checkout/issues/229)) ([d20df16](https://github.com/davetashner/supply-checkout/commit/d20df16e8f427b0b5af58e01d9d59541cb8dee7e))
* keep the seat quantity in sync with billed team members ([#213](https://github.com/davetashner/supply-checkout/issues/213)) ([124f1cf](https://github.com/davetashner/supply-checkout/commit/124f1cffd549d1ac79fad403faa7aac3858ad622))
* list a team's invoices in the app, from Stripe ([#231](https://github.com/davetashner/supply-checkout/issues/231)) ([d9ee646](https://github.com/davetashner/supply-checkout/commit/d9ee6469089690904eba0d5763606ce3bf588e02))
* require two-step sign-in for billing, with TOTP setup in the app ([#202](https://github.com/davetashner/supply-checkout/issues/202)) ([91242b8](https://github.com/davetashner/supply-checkout/commit/91242b87a63eb6412b3826b91c75a39fbf00acdf))


### Bug Fixes

* alert on operator group changes with a scheduled watch ([#209](https://github.com/davetashner/supply-checkout/issues/209)) ([19b51ae](https://github.com/davetashner/supply-checkout/commit/19b51ae0bc08094d128d4552701fd4ae4ee3e97b))
* harden the seat sync from the PR [#213](https://github.com/davetashner/supply-checkout/issues/213) review ([#233](https://github.com/davetashner/supply-checkout/issues/233)) ([2708316](https://github.com/davetashner/supply-checkout/commit/270831614c4bb45ea9d27033312241159e5617f2))
* keep the operator log-group rule inside EventBridge's complexity limit ([#241](https://github.com/davetashner/supply-checkout/issues/241)) ([632a05f](https://github.com/davetashner/supply-checkout/commit/632a05f8f8dc7a3cedc5d43a36859b746242ebd1))
* set Checkout's seat quantity from billed members on the server ([#224](https://github.com/davetashner/supply-checkout/issues/224)) ([cb8e2d3](https://github.com/davetashner/supply-checkout/commit/cb8e2d398b78e675500f2dbe59b771b3282ebb6b))

## [1.3.0](https://github.com/davetashner/supply-checkout/compare/v1.2.0...v1.3.0) (2026-09-28)


### Features

* add an operator admin CLI and skill ([#174](https://github.com/davetashner/supply-checkout/issues/174)) ([5808189](https://github.com/davetashner/supply-checkout/commit/580818994c3a4e7fc4b6667dab15d58c9d8b28e0))


### Bug Fixes

* add a CloudTrail trail so the CloudTrail alert rules receive events ([#184](https://github.com/davetashner/supply-checkout/issues/184)) ([acc258c](https://github.com/davetashner/supply-checkout/commit/acc258cae7483f5efa552415c99c5db2992194a6))
* pass operator passwords to the AWS CLI in a temp file, not /dev/stdin ([#179](https://github.com/davetashner/supply-checkout/issues/179)) ([776f1ae](https://github.com/davetashner/supply-checkout/commit/776f1ae68ce29e6daa0a556248e75e192803351d))
* rewrite the edge router's headers without for...of, which CloudFront rejects ([#169](https://github.com/davetashner/supply-checkout/issues/169)) ([4b313ee](https://github.com/davetashner/supply-checkout/commit/4b313eef018ddfbc2ab02dd14bd48f039730be74))
* split the operator alert rules to fit EventBridge's 2,048-character pattern limit ([#166](https://github.com/davetashner/supply-checkout/issues/166)) ([c83ae15](https://github.com/davetashner/supply-checkout/commit/c83ae1501be6a767033b5a96ae11f00a0235161a))

## [1.2.0](https://github.com/davetashner/supply-checkout/compare/v1.1.0...v1.2.0) (2026-09-27)


### Features

* add a barcode favicon ([#38](https://github.com/davetashner/supply-checkout/issues/38)) ([b2e9689](https://github.com/davetashner/supply-checkout/commit/b2e9689fab7fd83d6e84f7a384954a1f910b9f54))
* add a System / Light / Dark theme control ([#63](https://github.com/davetashner/supply-checkout/issues/63)) ([596a5db](https://github.com/davetashner/supply-checkout/commit/596a5dbb6f80c143fd82e6c5a574d37c7ec85e87))
* add alarm topics, journey alarms, a region-split dashboard and structured logging ([#30](https://github.com/davetashner/supply-checkout/issues/30)) ([e86ceb5](https://github.com/davetashner/supply-checkout/commit/e86ceb5f43e7943f685815ccc3e89fb1984b642e))
* add atomic, idempotent checkout, return and stock commands ([#49](https://github.com/davetashner/supply-checkout/issues/49)) ([93cc628](https://github.com/davetashner/supply-checkout/commit/93cc6289d39af163a4b9683f20cb47f5e0cd0c51))
* add backfills for the members count, the operators' index and stray index keys ([#116](https://github.com/davetashner/supply-checkout/issues/116)) ([8ab8e7b](https://github.com/davetashner/supply-checkout/commit/8ab8e7bb1120c30123f3b80ff73ce75b9188b119))
* add the Cognito user pool, auth domain and web app client ([#36](https://github.com/davetashner/supply-checkout/issues/36)) ([219e698](https://github.com/davetashner/supply-checkout/commit/219e698605d744e9fdda99bb66243e217c4b80cb))
* add the HTTP API and data Lambdas for products and sheets ([#37](https://github.com/davetashner/supply-checkout/issues/37)) ([560c9f3](https://github.com/davetashner/supply-checkout/commit/560c9f3e1e9f775a244fec14944d3596e53ad05c))
* add the platform operator role: operator pool with required TOTP, audited /ops routes and the ops CLI ([#99](https://github.com/davetashner/supply-checkout/issues/99)) ([73c8d88](https://github.com/davetashner/supply-checkout/commit/73c8d889cca9168b422502dcfc033e7c3c0e3b86))
* alarm on deferred live updates, email code failures, closure emails and overdue deletions ([#114](https://github.com/davetashner/supply-checkout/issues/114)) ([7a1cd8c](https://github.com/davetashner/supply-checkout/commit/7a1cd8c99362f44a0eca06aeee29ebeccf123493))
* alarm on stuck, rewritten and tampered deletion records ([#137](https://github.com/davetashner/supply-checkout/issues/137)) ([f3617f7](https://github.com/davetashner/supply-checkout/commit/f3617f7b836dfdba8ecba403f3ca0e8b79204906))
* alarm on unrevoked sign-outs, unsaved email verification, the SES quota and stuck imports ([#91](https://github.com/davetashner/supply-checkout/issues/91)) ([73995ad](https://github.com/davetashner/supply-checkout/commit/73995ad0213075dc5896d10d21e9d912f411f22b))
* alert on backup tampering and missing copies, and on team-reopened email failures ([#121](https://github.com/davetashner/supply-checkout/issues/121)) ([f5c486d](https://github.com/davetashner/supply-checkout/commit/f5c486dfae3f253a74ce0d537eb3108a509795a3))
* alert on operator user changes even from deploys, rule tampering, and operator audit changes ([#119](https://github.com/davetashner/supply-checkout/issues/119)) ([4435b6f](https://github.com/davetashner/supply-checkout/commit/4435b6f8e0c1d99f2460fce9b1b96b80fce7302a))
* apply Stripe webhooks through a FIFO queue to team plans, seats and status ([#149](https://github.com/davetashner/supply-checkout/issues/149)) ([5615093](https://github.com/davetashner/supply-checkout/commit/561509337daf1bebe04f4180727d268b434b1da8))
* back up the app table daily to a separate account with vault locks ([#80](https://github.com/davetashner/supply-checkout/issues/80)) ([39203a7](https://github.com/davetashner/supply-checkout/commit/39203a71efd35b794f9f2a28b54e4dee0fb1a23b))
* build a labeled demo of the web app ([#34](https://github.com/davetashner/supply-checkout/issues/34)) ([48db3bb](https://github.com/davetashner/supply-checkout/commit/48db3bbff1e646896b768ebadc5147e6d5149a59))
* cap members per team and bound live-update fan-out ([#93](https://github.com/davetashner/supply-checkout/issues/93)) ([83182e2](https://github.com/davetashner/supply-checkout/commit/83182e2e5f1344ca7db488629ae811bd4ad6e22b))
* check out and return through the atomic commands in the web build ([#69](https://github.com/davetashner/supply-checkout/issues/69)) ([db71acd](https://github.com/davetashner/supply-checkout/commit/db71acdf96ecb4436fd377e997d5b18adf648c87))
* convert receipt packs to eaches, keep client prices, and total sheets in cents ([#83](https://github.com/davetashner/supply-checkout/issues/83)) ([b2d015a](https://github.com/davetashner/supply-checkout/commit/b2d015a13db4c0891dacb5eae418e409ec1e0023))
* create Stripe products and prices by script, and start Checkout for a team's owner ([#143](https://github.com/davetashner/supply-checkout/issues/143)) ([96acc02](https://github.com/davetashner/supply-checkout/commit/96acc02deab46f83ccaf0e9ac7b35b4f7ca47d98))
* create teams and accept invites on first sign-in ([#40](https://github.com/davetashner/supply-checkout/issues/40)) ([76f8dae](https://github.com/davetashner/supply-checkout/commit/76f8daedd800db3fdbb1105ac672c10830db74bc))
* cut off live updates for removed members and canceled teams ([#71](https://github.com/davetashner/supply-checkout/issues/71)) ([f8f87ae](https://github.com/davetashner/supply-checkout/commit/f8f87ae2cb21673a5612cb89b96616be77d2a6d4))
* email every owner when a team closes, with the day it will be deleted ([#110](https://github.com/davetashner/supply-checkout/issues/110)) ([d68cb82](https://github.com/davetashner/supply-checkout/commit/d68cb82919e070a70154bbde313fd16ad912d419))
* enforce roles on every team route and add the members screen ([#78](https://github.com/davetashner/supply-checkout/issues/78)) ([f551074](https://github.com/davetashner/supply-checkout/commit/f551074df2dc5af481f68cae0fafbaa612b46637))
* guide a new team's owner with a first-run checklist ([#126](https://github.com/davetashner/supply-checkout/issues/126)) ([9a088c6](https://github.com/davetashner/supply-checkout/commit/9a088c66c303ec17bb413f7dd13d827611aabeb2))
* import a claude.ai artifact's export into a team ([#129](https://github.com/davetashner/supply-checkout/issues/129)) ([8852ae1](https://github.com/davetashner/supply-checkout/commit/8852ae16473f55a9899a325f9803007486ac64f9))
* import a team's inventory from CSV, all or nothing ([#67](https://github.com/davetashner/supply-checkout/issues/67)) ([3f6dc04](https://github.com/davetashner/supply-checkout/commit/3f6dc04b4b937a1681ae37e98ec1db269c44844a))
* invite members by email with a role ([#85](https://github.com/davetashner/supply-checkout/issues/85)) ([d494924](https://github.com/davetashner/supply-checkout/commit/d494924aac5ff5754f6087fa8a954048d91d7a67))
* keep deletion records and put a restored table back into service ([#123](https://github.com/davetashner/supply-checkout/issues/123)) ([a0a2e43](https://github.com/davetashner/supply-checkout/commit/a0a2e435d269451b5b70f12200a44fbb3c725a83))
* let a signed-in user verify their email address in the web app ([#105](https://github.com/davetashner/supply-checkout/issues/105)) ([e5f00ef](https://github.com/davetashner/supply-checkout/commit/e5f00effa4e6f441faad6ac26667046e7774ec19))
* let an operator reopen a closed team until 5 minutes before its purge, audited ([#120](https://github.com/davetashner/supply-checkout/issues/120)) ([00eae91](https://github.com/davetashner/supply-checkout/commit/00eae91fa2120e1ae0dcb4fee7053472b1fe5c98))
* let an owner reopen a closed team before the purge ([#113](https://github.com/davetashner/supply-checkout/issues/113)) ([9ad5aca](https://github.com/davetashner/supply-checkout/commit/9ad5acad725aa7d4dc1097195666834cf4fff5b2))
* let owners export all sheets and inventory as CSV and JSON ([#66](https://github.com/davetashner/supply-checkout/issues/66)) ([08a58d7](https://github.com/davetashner/supply-checkout/commit/08a58d7e340f2a46f3751e7fb1fc859e05ca7833))
* link a first Google or Apple sign-in to an existing account with the same email ([#72](https://github.com/davetashner/supply-checkout/issues/72)) ([22b82d9](https://github.com/davetashner/supply-checkout/commit/22b82d90ceeb9064bc8df34e4c3751eeb28819ae))
* list stuck imports and clear one from the check with an operator audit entry ([#102](https://github.com/davetashner/supply-checkout/issues/102)) ([e7b7428](https://github.com/davetashner/supply-checkout/commit/e7b7428c4a4a75395d4739d8dc273836f7446799))
* make every stack region-ready and fail CI on region names outside the config module ([#27](https://github.com/davetashner/supply-checkout/issues/27)) ([10d5764](https://github.com/davetashner/supply-checkout/commit/10d5764f609165ed156c06b9363a08d435c3ecc8))
* make the Supply Checkout logo go to the app's home ([#133](https://github.com/davetashner/supply-checkout/issues/133)) ([698dd86](https://github.com/davetashner/supply-checkout/commit/698dd868d9483b32c43be0741f348f9914cfd2b9))
* offer a CSV template and column guide in the import dialog ([#88](https://github.com/davetashner/supply-checkout/issues/88)) ([f058ae0](https://github.com/davetashner/supply-checkout/commit/f058ae00e789d199b0619e52ed35c56c2a7d9364))
* publish live changes to per-team AppSync Events channels ([#41](https://github.com/davetashner/supply-checkout/issues/41)) ([ca03841](https://github.com/davetashner/supply-checkout/commit/ca038411a5e2d56494fef4e459294c98ac040a19))
* replicate deletion records to the backup account ([#128](https://github.com/davetashner/supply-checkout/issues/128)) ([3c0f62a](https://github.com/davetashner/supply-checkout/commit/3c0f62ac93f7cb50fbeb0a294f480633eeed8324))
* require an expected version on every document write ([#64](https://github.com/davetashner/supply-checkout/issues/64)) ([b6a6ecb](https://github.com/davetashner/supply-checkout/commit/b6a6ecb5b39ed6511d0055df30563ee4bbb065e5))
* run the web build against the AWS backend ([#47](https://github.com/davetashner/supply-checkout/issues/47)) ([4a79dac](https://github.com/davetashner/supply-checkout/commit/4a79dac62f0f93408da1481d28f50849759a41a0))
* scale the operator team list and close the remaining ways to silence operator alerts ([#142](https://github.com/davetashner/supply-checkout/issues/142)) ([20b4b2c](https://github.com/davetashner/supply-checkout/commit/20b4b2cd42c80319de81b1f81b36a77e5aec4514))
* self-serve account deletion, team closure and leaving a team ([#103](https://github.com/davetashner/supply-checkout/issues/103)) ([e4f9a88](https://github.com/davetashner/supply-checkout/commit/e4f9a88c73d9b33e9bf519c26735c9701d3f08dd))
* send inventory counts and receipt stock-in through the stock command ([#76](https://github.com/davetashner/supply-checkout/issues/76)) ([d2d3365](https://github.com/davetashner/supply-checkout/commit/d2d33654905cc547b537013e8565d1e4457ea5d5))
* send transactional email with SES and mark bounced invites failed ([#73](https://github.com/davetashner/supply-checkout/issues/73)) ([eb247a3](https://github.com/davetashner/supply-checkout/commit/eb247a3843fcf8a9ad7bbb5eca0be1e74a1553c7))
* serve the demo at /demo and send the home page to the app ([#60](https://github.com/davetashner/supply-checkout/issues/60)) ([87460a6](https://github.com/davetashner/supply-checkout/commit/87460a6d99a0220aa5da4cbbfe61ed37b8a6df3e))
* set email_verified for Google and Apple sign-ins from the provider's claim ([#65](https://github.com/davetashner/supply-checkout/issues/65)) ([ac9e13b](https://github.com/davetashner/supply-checkout/commit/ac9e13b860c02bd8627a6761da88a2220898ed86))
* show saving and failed states for checkouts and returns, and make retries safe ([#90](https://github.com/davetashner/supply-checkout/issues/90)) ([9d2ccbb](https://github.com/davetashner/supply-checkout/commit/9d2ccbbd93baa72a5912131a62958082961185ab))
* show seats, support activity, the reopen deadline and a closure notice on the team screens ([#127](https://github.com/davetashner/supply-checkout/issues/127)) ([9c81756](https://github.com/davetashner/supply-checkout/commit/9c81756e5ec42aee6896fd56f7bc374390732864))
* tell artifact users how to move to the web app ([#138](https://github.com/davetashner/supply-checkout/issues/138)) ([844787b](https://github.com/davetashner/supply-checkout/commit/844787b569422f0d5427a2dad70292463748721e))


### Bug Fixes

* batch live-update publishes per collection, tighten the consumer, primary-only check alarms ([#141](https://github.com/davetashner/supply-checkout/issues/141)) ([f40f16b](https://github.com/davetashner/supply-checkout/commit/f40f16bbd7233eefc9c877f17968a5d32128e780))
* bundle the barcode reader and harden sign-out ([#55](https://github.com/davetashner/supply-checkout/issues/55)) ([94ad3f0](https://github.com/davetashner/supply-checkout/commit/94ad3f0a02ccfcee343aa5e44391677e3501b45c))
* check product money and match only DynamoDB's item-size refusal ([#134](https://github.com/davetashner/supply-checkout/issues/134)) ([f8889ef](https://github.com/davetashner/supply-checkout/commit/f8889ef7a94f8560d0ad101080715d59c33b98b1))
* clear the receipt draft on sign-out, block refreshes while signing out, and time out requests ([#61](https://github.com/davetashner/supply-checkout/issues/61)) ([4c861af](https://github.com/davetashner/supply-checkout/commit/4c861af826f61b88901d33c10ef7c77caed79e40))
* count a receipt's lines in their own ReceiptLines metric, apart from Checkouts ([#101](https://github.com/davetashner/supply-checkout/issues/101)) ([0e0d49d](https://github.com/davetashner/supply-checkout/commit/0e0d49db025b8beebc1986da10b22da188720b81))
* count artifact checkouts, returns and receipt stock once on retry, and lock a receipt until it's saved ([#100](https://github.com/davetashner/supply-checkout/issues/100)) ([fc5cfb0](https://github.com/davetashner/supply-checkout/commit/fc5cfb05c2cab95fff627939d436dbafbbf04154))
* handle built-in object names as product keys and oversized sheets in the commands ([#53](https://github.com/davetashner/supply-checkout/issues/53)) ([9b7db81](https://github.com/davetashner/supply-checkout/commit/9b7db81923f1c77683c87daafd5ef3f0b9d98b45))
* harden the edge router and the publish script ([#62](https://github.com/davetashner/supply-checkout/issues/62)) ([b68a034](https://github.com/davetashner/supply-checkout/commit/b68a0340f1f0a8da08f661a606f51f1fa23a4d66))
* hide the first-run checklist when the team closes while the page is open ([#146](https://github.com/davetashner/supply-checkout/issues/146)) ([b51c704](https://github.com/davetashner/supply-checkout/commit/b51c70479e2d1a00c145d62965cafceb7fc25fd7))
* keep a failed linked-email downgrade from being recorded at a later refresh ([#104](https://github.com/davetashner/supply-checkout/issues/104)) ([4aceb18](https://github.com/davetashner/supply-checkout/commit/4aceb18f632ac5f0d53458431d2912c564c26a03))
* keep a linked account's email_verified to the address Cognito verified ([#97](https://github.com/davetashner/supply-checkout/issues/97)) ([77aebd8](https://github.com/davetashner/supply-checkout/commit/77aebd82a51f4d22417277a129ee129574faf0ce))
* keep a receipt draft per team and forget another user's saved team and drafts ([#89](https://github.com/davetashner/supply-checkout/issues/89)) ([06403d3](https://github.com/davetashner/supply-checkout/commit/06403d3f9d8c4c2184f9877f91478598e0c9c11a))
* keep a waiting land alive when the other land's lock goes mid-check ([#148](https://github.com/davetashner/supply-checkout/issues/148)) ([ce1b479](https://github.com/davetashner/supply-checkout/commit/ce1b479cfd7d7c641394ea50736bfb96e20b4d71))
* keep and check a sheet line's cost, and round typed line prices to cents ([#86](https://github.com/davetashner/supply-checkout/issues/86)) ([397ea32](https://github.com/davetashner/supply-checkout/commit/397ea32666c6f544eb9042ef4a5994e64d832711))
* keep API function logs for one year ([#43](https://github.com/davetashner/supply-checkout/issues/43)) ([418dd4d](https://github.com/davetashner/supply-checkout/commit/418dd4d9c3f19d6eea8b48ff9525d086baf7fb30))
* keep cost and pack size when editing an inventory item ([#70](https://github.com/davetashner/supply-checkout/issues/70)) ([e07ff2c](https://github.com/davetashner/supply-checkout/commit/e07ff2cf4c84e7d1d3142fb9e138d39b1a75c37a))
* keep members' stored email current when their verified address changes ([#112](https://github.com/davetashner/supply-checkout/issues/112)) ([87be222](https://github.com/davetashner/supply-checkout/commit/87be222a6031980840cabbed434452276bce3a5c))
* keep taps on a sheet during redraws, and say when a sheet was deleted ([#82](https://github.com/davetashner/supply-checkout/issues/82)) ([721172d](https://github.com/davetashner/supply-checkout/commit/721172da869019200a2cfb5ef02f2151d978a8e8))
* keep the barcode and other app fields on documents saved through the API ([#46](https://github.com/davetashner/supply-checkout/issues/46)) ([cd278f2](https://github.com/davetashner/supply-checkout/commit/cd278f22444e9d15c7a69c57354f30e3172f7d10))
* keep the sheet list's buttons when a snapshot redraws it ([#77](https://github.com/davetashner/supply-checkout/issues/77)) ([1fb8fa3](https://github.com/davetashner/supply-checkout/commit/1fb8fa328fdc2dd114f62eca7120ee2509cce7dc))
* let CloudWatch publish to the alarm topics and send Cognito email through SES ([#52](https://github.com/davetashner/supply-checkout/issues/52)) ([cc530c2](https://github.com/davetashner/supply-checkout/commit/cc530c2981df4c0dc72b302450a75220ddca14cf))
* mark closed teams purging before deleting, count every overdue team, and alarm when the purge stops ([#117](https://github.com/davetashner/supply-checkout/issues/117)) ([92eed6d](https://github.com/davetashner/supply-checkout/commit/92eed6d9fb4cb2d3b11693b393fbf3d476abd8ae))
* move stock only through the stock commands, and retry a lost count without a conflict ([#84](https://github.com/davetashner/supply-checkout/issues/84)) ([29086bc](https://github.com/davetashner/supply-checkout/commit/29086bcb7f2ad791778a9fa1b6789fb36bf4cf2e))
* queue each document's writes, retry a conflicting checkout once, and guard the artifact's line removal and owed count ([#139](https://github.com/davetashner/supply-checkout/issues/139)) ([54fe036](https://github.com/davetashner/supply-checkout/commit/54fe036a602396c7f0fa3f790d625d0f634703e4))
* read every version of the deletion records in a restore ([#130](https://github.com/davetashner/supply-checkout/issues/130)) ([cdcaa50](https://github.com/davetashner/supply-checkout/commit/cdcaa50d7deb3399701f4471fc701ae75c43ba13))
* record a linked user's email only after a code proved it, not at refresh ([#107](https://github.com/davetashner/supply-checkout/issues/107)) ([a25b941](https://github.com/davetashner/supply-checkout/commit/a25b941d73d6f0499bd6c1bbc5c44c2d2ae9ee3b))
* refresh the team bar after a closure, retry support activity, and re-read the member cap ([#136](https://github.com/davetashner/supply-checkout/issues/136)) ([ad64e18](https://github.com/davetashner/supply-checkout/commit/ad64e187597efa5b4a39e74651ccd3ab7389b91a))
* retry an artifact checkout's failed stock write once, and refuse a return on a removed line ([#106](https://github.com/davetashner/supply-checkout/issues/106)) ([1629a67](https://github.com/davetashner/supply-checkout/commit/1629a67150f1b4f91dc9c0812ae9b4c1cf5f0f9e))
* round money to cents and show the price limit in the forms ([#147](https://github.com/davetashner/supply-checkout/issues/147)) ([3418ce2](https://github.com/davetashner/supply-checkout/commit/3418ce2ef1cf4099b7b703fc916ebe0512313095))
* save a receipt's lines to a sheet once, however often it's retried ([#94](https://github.com/davetashner/supply-checkout/issues/94)) ([5012c78](https://github.com/davetashner/supply-checkout/commit/5012c78f6c08b498c22272e5fdea4defd9697cb2))
* send sheet actions and deletes once, and time out artifact writes ([#95](https://github.com/davetashner/supply-checkout/issues/95)) ([d81f81d](https://github.com/davetashner/supply-checkout/commit/d81f81dd271cf0674f06bcebe70ac27d03d85e08))
* show the server's reason when a checkout or return is refused ([#75](https://github.com/davetashner/supply-checkout/issues/75)) ([838645a](https://github.com/davetashner/supply-checkout/commit/838645aa6dbe9aff79f1b7287d55ccb3456b02cf))
* start the verify-email dialog over when the address changed ([#111](https://github.com/davetashner/supply-checkout/issues/111)) ([2072499](https://github.com/davetashner/supply-checkout/commit/2072499de06e71eb80d69238dc31c933b0ca6110))
* stop a tab when another tab changes who's signed in, and guard the ended session ([#135](https://github.com/davetashner/supply-checkout/issues/135)) ([36241fa](https://github.com/davetashner/supply-checkout/commit/36241fa100b44efa80c3f32fcea6971c94ed2e16))
* stop live updates when the session ends, so sign-out racing a refresh can't read a cleared token ([#108](https://github.com/davetashner/supply-checkout/issues/108)) ([4d2faaa](https://github.com/davetashner/supply-checkout/commit/4d2faaa449f0f72e3f59af96aac730928d5a07d6))
* stop WebKit refocusing a modal's first field, and deliver fake socket messages at once ([#96](https://github.com/davetashner/supply-checkout/issues/96)) ([1f654fe](https://github.com/davetashner/supply-checkout/commit/1f654fef5b16fd086a084cf7bf56b8302de56083))
* sync theme preferences across open tabs ([#152](https://github.com/davetashner/supply-checkout/issues/152)) ([45ac9d5](https://github.com/davetashner/supply-checkout/commit/45ac9d58632ab5937b6726ee0ae36747ec0c73a4))
* tighten invite acceptance, dedupe and limits, and refresh member emails at verify ([#140](https://github.com/davetashner/supply-checkout/issues/140)) ([917f651](https://github.com/davetashner/supply-checkout/commit/917f6510781c1de0e046ea95402b5a3afd6697a1))
* tolerate legacy sheet money and stock, record a movement on product delete, and tighten the import's size match ([#124](https://github.com/davetashner/supply-checkout/issues/124)) ([31a86a2](https://github.com/davetashner/supply-checkout/commit/31a86a26f92e50bab4a98fe55c0426eef6583ba7))
* use own-property lookups for item keys and stop refreshes on sign-out ([#58](https://github.com/davetashner/supply-checkout/issues/58)) ([d34e05f](https://github.com/davetashner/supply-checkout/commit/d34e05f964edf2bc65d4f20a79e96c8166cac946))


### Performance Improvements

* answer a burst of live events with one re-list, not a fetch each ([#87](https://github.com/davetashner/supply-checkout/issues/87)) ([79ee700](https://github.com/davetashner/supply-checkout/commit/79ee700fde73544f72a09e1241f1f5affdf1490f))

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
