---
sidebar_position: 1
---

# ADR 範本

複製此檔、改名為 `docs/adr/NNNN-your-decision.md`、填每段。一個決策一個檔。用法見 [概念：ADR 模式](../concepts/adr-patterns.md)。

---

```markdown
# ADR-NNNN: <決策標題>

- **Status:** Proposed <!-- Proposed | Accepted | Deprecated | Superseded by ADR-XXXX -->
- **Date:** YYYY-MM-DD
- **Deciders:** @owner, @reviewer-1
- **Tags:** <!-- backend, frontend, migration, infra, ... -->

## Context

<為什麼現在需要這個決策？限制、先前作法、現有失敗模式？3–6 句。>

## Decision

<一句祈使句開頭。再補細節。>

## Consequences

### Positive
- <每條是具體結果、不是願景>

### Negative
- <每個非平凡決策有下行。命名它。>

### Neutral
- <需關注但不 block 的事>

## Alternatives Considered

### Alternative A: <名稱>
- **Pros:**
- **Cons:**
- **Rejected because:**

### Alternative B: <名稱>
...

## References

- <先前 ADR、外部文件、benchmark、RFC>
- <北極星文件相關段落>
```
