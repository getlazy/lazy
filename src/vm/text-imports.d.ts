// The solo machine's guest relay script, embedded as text (Bun `with { type: 'text' }`).
declare module '*solo-guest-relays.sh' {
  const content: string;
  export default content;
}
