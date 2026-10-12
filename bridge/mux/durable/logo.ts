// The durable adapter's mark, as bytes this adapter owns. The rules are stated once, in
// bridge/mux/tmux/logo.ts; this file only records what is different.
//
// A durable program has no terminal, so its mark is a plain speech bubble with a small cursor bar
// inside it, drawn for this adapter. It is not any program's logo. It is a standalone SVG with no
// link, no url(), no script and a viewBox, on a mid grey that reads on both muted backgrounds.
export const DURABLE_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#767676" d="M6 4h20a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H15l-7 5v-5H6a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4z"/><rect x="8" y="10" width="16" height="3" rx="1.5" fill="#f4f4f5"/><rect x="8" y="16" width="9" height="3" rx="1.5" fill="#1bb91f"/></svg>`;
