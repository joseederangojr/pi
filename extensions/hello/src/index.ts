export type ExtensionManifest = {
  name: string;
  entry: string;
};

export function defineExtension(name: string, entry: string): ExtensionManifest {
  return { name, entry };
}
