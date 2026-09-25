// Lets TypeScript see `import x from './file.sql' with { type: 'text' }`.
declare module '*.sql' {
  const text: string;
  export default text;
}
