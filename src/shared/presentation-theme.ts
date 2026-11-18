// SDK syntax tokens are optional and are published as empty CSS variables when
// absent. CSS var() alone cannot fall back from a defined-but-empty value.
export function inspectionSyntaxTheme(tokens: {
  readonly syntaxKeyword?: string; readonly syntaxType?: string; readonly syntaxNumber?: string;
  readonly primaryText: string; readonly infoText: string;
}) {
  return {
    '--oc-k8s-code-key': tokens.syntaxKeyword?.trim() || tokens.primaryText,
    '--oc-k8s-code-heading': tokens.syntaxType?.trim() || tokens.primaryText,
    '--oc-k8s-code-number': tokens.syntaxNumber?.trim() || tokens.infoText,
  };
}
