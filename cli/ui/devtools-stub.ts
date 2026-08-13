// A stand-in for `react-devtools-core`, wired in by `tsconfig.json`'s `paths`.
//
// ink's reconciler reaches for the devtools bridge behind `process.env.DEV === 'true'`, and never
// takes that branch here. But `bun build --compile` resolves every import it can see — including the
// one inside the branch — at BUILD time, and a missing package there is a hard error; leaving it
// `--external` instead moves the failure to START-UP, where the compiled binary refuses to run at
// all ("Cannot find package 'react-devtools-core' from '/$bunfs/root/collie'"). Both were observed
// while wiring this up.
//
// So the import is made to resolve, to this. It is dead code in the binary and the branch that would
// call it cannot be reached from a Collie verb — nothing here sets `DEV`.
export default {};
