import mermaid from 'mermaid';

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base', themeVariables: {
  primaryColor: '#dbeafe', primaryTextColor: '#172554', primaryBorderColor: '#2563eb',
  lineColor: '#475569', secondaryColor: '#f1f5f9', tertiaryColor: '#ffffff',
} });

async function render(): Promise<void> {
  const figures = [...document.querySelectorAll<HTMLElement>('figure.doc-diagram')];
  for (const [index, figure] of figures.entries()) {
    const source = figure.querySelector('pre')?.textContent ?? '';
    try {
      const { svg } = await mermaid.render(`doc-diagram-${index}`, source);
      const holder = document.createElement('div');
      holder.innerHTML = svg;
      const element = holder.querySelector('svg');
      if (!element) throw new Error('No SVG returned');
      element.setAttribute('role', 'img');
      element.setAttribute('aria-label', figure.querySelector('figcaption')?.textContent ?? 'Diagram');
      figure.querySelector('pre')?.replaceWith(element);
    } catch (error) {
      figure.insertAdjacentText('beforeend', `Diagram could not render: ${String(error)}`);
    }
  }
}
void render();
