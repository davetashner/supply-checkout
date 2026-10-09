/**
 * A deploy's own calls carry this in userIdentity.invokedBy; a person's or a
 * script's have none. It exempts a call made through any CloudFormation
 * stack, not only this app's: someone who can create a stack can make an
 * `outsideDeploys` call unseen (docs/infrastructure.md, "What the rules don't list").
 */
export const NOT_CLOUDFORMATION = { invokedBy: [{ exists: false }, { "anything-but": "cloudformation.amazonaws.com" }] };
/** CloudFormation's own calls during a deploy: the other side of NOT_CLOUDFORMATION. */
export const BY_CLOUDFORMATION = { invokedBy: ["cloudformation.amazonaws.com"] };
