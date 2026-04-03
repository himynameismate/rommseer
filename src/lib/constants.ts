/** Known ROM extensions per platform. Shared across prowlarr.ts and postcopy.ts. */
export const ROM_EXTENSIONS = new Set([
  // Nintendo
  ".gb", ".gbc", ".gba", ".nds", ".dsi", ".srl", ".3ds", ".cia", ".cxi", ".cci",
  ".nes", ".unf", ".unif", ".fds", ".sfc", ".smc", ".fig", ".swc",
  ".n64", ".z64", ".v64", ".ndd", ".iso", ".gcm", ".gcz", ".rvz", ".nkit", ".ciso",
  ".wbfs", ".wad", ".wud", ".wux", ".rpx", ".wua", ".nsp", ".xci", ".nsz", ".xcz",
  ".vb", ".vboy", ".min", ".mgw",
  // Sony
  ".pbp", ".cso", ".chd", ".pkg", ".vpk",
  // Sega
  ".sms", ".gg", ".md", ".gen", ".smd", ".32x", ".cue", ".gdi", ".cdi",
  // Other
  ".a26", ".a52", ".a78", ".lnx", ".pce", ".ngp", ".ngc", ".ws", ".wsc",
  ".col", ".sg",
  // Archives that may contain ROMs
  ".zip", ".7z", ".rar",
]);

/** Fields masked with "********" in API responses. */
export const SECRET_FIELDS = ["rommApiKey", "rommPassword", "igdbClientSecret", "qbitPassword", "prowlarrApiKey", "sabnzbdApiKey"] as const;

/** Mask sensitive fields for API responses. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function maskSecrets(settings: Record<string, any>): Record<string, any> {
  const result = { ...settings };
  for (const key of SECRET_FIELDS) {
    if (key in result) {
      result[key] = result[key] ? "********" : "";
    }
  }
  return result;
}
