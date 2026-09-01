export default function HomePage() {
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "72px 24px" }}>
      <p style={{ color: "#caa85e", letterSpacing: "0.16em", textTransform: "uppercase", fontSize: 12 }}>
        SigRank × Vercel
      </p>
      <h1 style={{ fontSize: 40, lineHeight: 1.08, margin: "16px 0" }}>Your project-owned SigRank MCP endpoint is live.</h1>
      <p style={{ color: "#b9b4aa", lineHeight: 1.7 }}>
        This deployment relays Model Context Protocol traffic to the canonical SigRank remote server at signalaf.com. You get a Vercel-owned URL without copying or forking the SigRank metric implementation.
      </p>

      <section style={{ marginTop: 36, padding: 20, border: "1px solid #303030", borderRadius: 12 }}>
        <p style={{ marginTop: 0, color: "#8f8a80", fontSize: 13 }}>MCP endpoint</p>
        <code style={{ display: "block", overflowWrap: "anywhere", fontSize: 15 }}>{`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "your-project.vercel.app"}/api/mcp`}</code>
      </section>

      <div style={{ marginTop: 32, display: "flex", gap: 18, flexWrap: "wrap" }}>
        <a href="https://signalaf.com/mcp" style={{ color: "#caa85e" }}>MCP tools & docs</a>
        <a href="https://signalaf.com/vercel" style={{ color: "#caa85e" }}>Vercel diagnostic</a>
        <a href="https://signalaf.com" style={{ color: "#caa85e" }}>SignalAF</a>
      </div>

      <p style={{ marginTop: 48, color: "#77736b", fontSize: 12, lineHeight: 1.6 }}>
        Canonical upstream: https://signalaf.com/api/mcp. This relay does not receive prompt content beyond the MCP request payload your client sends to SigRank and does not create a second implementation of SigRank scoring logic.
      </p>
    </main>
  );
}
