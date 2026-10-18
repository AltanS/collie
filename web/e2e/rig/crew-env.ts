// The crew leg's side of the switch: the crew Playwright config, its setup and teardown and its spec
// import this FIRST, so rig-lib.ts resolves the crew rig's state root (`browser-leg-crew-state`) and
// the workers Playwright starts inherit it. The solo leg never imports it.
process.env.COLLIE_RIG_CREW = "1";
