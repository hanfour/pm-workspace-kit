const PROGRAM_ENTRY_RE = /<key>ProgramArguments<\/key>\s*<array>\s*<string>[^<]*<\/string>\s*<string>([^<]*)<\/string>/;

/** Extract the entry argument and undo buildPlist's XML escaping exactly once. */
export function plistEntryPoint(plistXml: string | undefined): string | undefined {
  const entry = plistXml === undefined ? undefined : PROGRAM_ENTRY_RE.exec(plistXml)?.[1];
  return entry
    ?.replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    // Decode ampersands last so literal entity text is not decoded twice.
    .replace(/&amp;/g, "&");
}
