// The guest preparation script, embedded as text (Bun `with { type: 'text' }`).
declare module '*lazy-guest-init' {
  const content: string;
  export default content;
}
