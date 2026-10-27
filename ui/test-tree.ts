import type { ReactElement, ReactNode } from 'react';

/** Test helper: a React element whose props tests read freely. */
export type Element = ReactElement<Record<string, any>>;

/** Every element in a rendered tree, parents first; `extraProp` also walks one more prop that holds nodes (such as a modal's footer). */
export function elements(node: ReactNode, extraProp?: string): Element[] {
  if (Array.isArray(node)) return node.flatMap((child) => elements(child, extraProp));
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children, extraProp), ...(extraProp ? elements(element.props[extraProp], extraProp) : [])];
}
