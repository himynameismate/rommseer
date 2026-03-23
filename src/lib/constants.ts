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
