// A service-owned runtime receives only validated transport and explicit UI
// effects. No browser globals, SDK connection, files or execution imports.
export type ProjectRuntimeHost = {
  readonly workspaceId: string;
  serviceRequest(request: { method: 'GET' | 'POST'; path: string; body?: string }): Promise<{ status: number; body: string }>;
  onReady(callback: (context: { directory: string | null; locale: string }) => void): () => void;
  onDirectory(callback: (directory: string | null) => void): () => void;
  storage: {
    get(key: string, options?: { scope: 'instance' }): Promise<unknown>;
    set(key: string, value: unknown, options?: { scope: 'instance' }): Promise<void>;
  };
  writeClipboard(text: string): Promise<void>;
  openUrl(url: string): Promise<void>;
  dispose(): void;
};
