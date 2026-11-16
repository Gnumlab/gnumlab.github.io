import fs from "node:fs"
import path from "node:path"

const BIB_PATH = path.resolve("content/references.bib")
const MD_PATH = path.resolve("content/publications.md")
const MARKER = "<!-- PUBLICATIONS_START -->"

// Fields stripped from the displayed <details> BibTeX snippet
const STRIP_FIELDS = new Set([
  "abstract",
  "keywords",
  "timestamp",
  "biburl",
  "bibsource",
  "issue_date",
  "numpages",
  "month",
  "issn",
  "isbn",
  "venue_short", // optional custom override field
])

// Short venue labels used when a paper has multiple BibTeX entries
const VENUE_ALIASES = [
  [/vldb/i, "VLDB"],
  [/wsdm/i, "WSDM"],
  [/algorithms and data structures|wads/i, "WADS"],
  [/journal of computer and system sciences|jcss/i, "JCSS"],
  [/iwoca/i, "IWOCA"],
  [/journal of graph algorithms and applications|jgaa/i, "JGAA"],
  [/sigsim-pads|pads/i, "SIGSIM-PADS"],
  [/euromicro.*pdp|\(pdp\)/i, "PDP"],
]

// ---------- 1. Lightweight BibTeX parser ----------

function parseBibtex(input) {
  const entries = []
  let i = 0
  const n = input.length

  while (i < n) {
    const at = input.indexOf("@", i)
    if (at === -1) break
    i = at + 1

    // Read entry type
    const typeMatch = input.slice(i).match(/^([a-zA-Z]+)\s*([{(])/)
    if (!typeMatch) continue
    const type = typeMatch[1]
    const openChar = typeMatch[2]
    const closeChar = openChar === "{" ? "}" : ")"
    i += typeMatch[0].length

    if (["comment", "preamble", "string"].includes(type.toLowerCase())) {
      let depth = 1
      while (i < n && depth > 0) {
        if (input[i] === openChar) depth++
        else if (input[i] === closeChar) depth--
        i++
      }
      continue
    }

    // Read citation key
    const commaIdx = input.indexOf(",", i)
    if (commaIdx === -1) break
    const key = input.slice(i, commaIdx).trim()
    i = commaIdx + 1

    const fields = {}
    while (i < n) {
      // Skip whitespace and commas
      while (i < n && /[\s,]/.test(input[i])) i++
      if (i >= n || input[i] === closeChar) {
        i++
        break
      }

      // Field name
      const eqIdx = input.indexOf("=", i)
      if (eqIdx === -1) break
      const fieldName = input.slice(i, eqIdx).trim().toLowerCase()
      i = eqIdx + 1

      // Skip whitespace
      while (i < n && /\s/.test(input[i])) i++

      // Field value
      let val = ""
      if (input[i] === "{") {
        let depth = 1
        i++
        const start = i
        while (i < n && depth > 0) {
          if (input[i] === "{") depth++
          else if (input[i] === "}") depth--
          if (depth > 0) i++
        }
        val = input.slice(start, i)
        i++ // consume closing '}'
      } else if (input[i] === '"') {
        let depth = 0
        i++
        const start = i
        while (i < n) {
          if (input[i] === "\\" && i + 1 < n) {
            i += 2
            continue
          }
          if (input[i] === "{") depth++
          else if (input[i] === "}") depth = Math.max(0, depth - 1)
          else if (input[i] === '"' && depth === 0) break
          i++
        }
        val = input.slice(start, i)
        i++ // consume closing '"'
      } else {
        const start = i
        while (i < n && ![, closeChar].includes(input[i])) i++
        val = input.slice(start, i).trim()
      }

      fields[fieldName] = val.replace(/\s+/g, " ").trim()
    }

    entries.push({ type, key, fields })
  }

  return entries
}

// ---------- 2. LaTeX & Author formatting ----------

function cleanLatex(str = "") {
  const accentMap = {
    "`": { a: "à", e: "è", i: "ì", o: "ò", u: "ù", A: "À", E: "È", I: "Ì", O: "Ò", U: "Ù" },
    "'": { a: "á", e: "é", i: "í", o: "ó", u: "ú", A: "Á", E: "É", I: "Í", O: "Ó", U: "Ú", c: "ć", n: "ń" },
    "^": { a: "â", e: "ê", i: "î", o: "ô", u: "û", A: "Â", E: "Ê", I: "Î", O: "Ô", U: "Û" },
    '"': { a: "ä", e: "ë", i: "ï", o: "ö", u: "ü", A: "Ä", E: "Ë", I: "Ï", O: "Ö", U: "Ü" },
    "~": { a: "ã", n: "ñ", o: "õ", A: "Ã", N: "Ñ", O: "Õ" },
  }

  let s = str
  // Handle {\`{a}}, {\`a}, \`{a}, \`a
  s = s.replace(/\{\\([`'"^~])\{?([a-zA-Z])\}?\}/g, (_, acc, ch) => accentMap[acc]?.[ch] ?? ch)
  s = s.replace(/\\([`'"^~])\{?([a-zA-Z])\}?/g, (_, acc, ch) => accentMap[acc]?.[ch] ?? ch)
  s = s.replace(/\{\\c\{?([cC])\}?\}/g, (_, ch) => (ch === "C" ? "Ç" : "ç"))
  s = s.replace(/\{\\l\}/g, "ł").replace(/\\l\b/g, "ł")
  s = s.replace(/\\&/g, "&").replace(/\\_/g, "_").replace(/~/g, " ")
  // Remove inline math $...$ wrappers (e.g. $2$-hop -> 2-hop) and remaining braces
  s = s.replace(/\$([^$]+)\$/g, "$1")
  s = s.replace(/[{}]/g, "")
  return s.replace(/\s+/g, " ").trim()
}

function formatAuthors(rawAuthor = "") {
  // Split on " and " outside braces
  const parts = rawAuthor.split(/\s+and\s+/i)
  return parts
    .map((author) => {
      const cleaned = cleanLatex(author)
      if (cleaned.includes(",")) {
        const [last, first] = cleaned.split(",").map((p) => p.trim())
        return `${first} ${last}`.trim()
      }
      return cleaned
    })
    .join(", ")
}

function isArxivEntry(entry) {
  const { key, type, fields } = entry
  return (
    /^ARXIV/i.test(key) ||
    /arxiv/i.test(fields.archiveprefix || "") ||
    /arxiv/i.test(fields.eprinttype || "") ||
    /^CoRR$/i.test(cleanLatex(fields.journal || "")) ||
    (type.toLowerCase() === "misc" && Boolean(fields.eprint))
  )
}

function getEntryRank(entry) {
  // Higher rank = preferred as the primary display entry
  if (isArxivEntry(entry)) return 1
  if (entry.type.toLowerCase() === "inproceedings") return 2
  if (entry.type.toLowerCase() === "article") return 3
  return 2
}

function getShortVenue(entry) {
  if (entry.fields.venue_short) return entry.fields.venue_short
  if (isArxivEntry(entry)) return "arXiv"
  const text = cleanLatex(
    `${entry.fields.series || ""} ${entry.fields.journal || ""} ${entry.fields.booktitle || ""}`
  )
  for (const [regex, label] of VENUE_ALIASES) {
    if (regex.test(text)) return label
  }
  return entry.type.toLowerCase() === "article" ? "Journal" : "Conf"
}

function formatVenueText(entry) {
  const f = entry.fields
  if (isArxivEntry(entry)) {
    const vol = f.volume || (f.eprint ? `abs/${f.eprint}` : "")
    return `CoRR${vol ? `, ${vol}` : ""} (${f.year})`
  }
  if (entry.type.toLowerCase() === "article") {
    const j = cleanLatex(f.journal || "")
    const vol = f.volume ? ` ${f.volume}` : ""
    const num = f.number ? `(${f.number})` : ""
    return `${j}${vol}${num}`.trim()
  }
  if (f.series) return cleanLatex(f.series)

  let bt = cleanLatex(f.booktitle || "")
  const short = getShortVenue(entry)
  const suffixParts = []
  if (short && short !== "Conf" && !bt.toLowerCase().includes(short.toLowerCase())) {
    suffixParts.push(short)
  }
  if (f.year && !bt.includes(f.year)) {
    suffixParts.push(f.year)
  }
  return suffixParts.length > 0 ? `${bt} (${suffixParts.join(", ")})` : bt
}


function formatBibtexBlock(entry) {
  const lines = [`@${entry.type}{${entry.key},`]
  const keys = Object.keys(entry.fields).filter((k) => !STRIP_FIELDS.has(k))
  keys.forEach((k, idx) => {
    const comma = idx < keys.length - 1 ? "," : ""
    lines.push(`  ${k.padEnd(10)} = {${entry.fields[k]}}${comma}`)
  })
  lines.push("}")
  // Escape HTML special chars for safe rendering inside <pre><code>
  return lines.join("\n").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function getGroupKey(entry) {
  // Strip known prefixes like ARXIV, CONFERENCE, WORKSHOP, JOURNAL
  return entry.key.replace(/^(ARXIV|CONFERENCE|WORKSHOP|JOURNAL|PREPRINT)/i, "")
}

// ---------- 3. Group, Sort, and Render ----------

function generateMarkdown(entries) {
  const groupsMap = new Map()

  for (const entry of entries) {
    const gk = getGroupKey(entry)
    if (!groupsMap.has(gk)) groupsMap.set(gk, [])
    groupsMap.get(gk).push(entry)
  }

  const items = []

  for (const group of groupsMap.values()) {
    const published = group
      .filter((e) => !isArxivEntry(e))
      .sort((a, b) => {
        const yearDiff = Number(b.fields.year || 0) - Number(a.fields.year || 0)
        if (yearDiff !== 0) return yearDiff
        return getEntryRank(b) - getEntryRank(a)
      })

    const arxivEntries = group.filter((e) => isArxivEntry(e))

    if (published.length === 0) {
      // Standalone arXiv preprint: display as-is in its own year
      const primary = arxivEntries[0]
      items.push({
        primary,
        bibEntries: [primary],
        year: Number(primary.fields.year || 0),
        isStandaloneArxiv: true,
      })
    } else {
      // One bullet per published version in its own year.
      // Attach any arXiv BibTeX to the latest published version (idx === 0).
      published.forEach((pubEntry, idx) => {
        const bibEntries = idx === 0 ? [pubEntry, ...arxivEntries] : [pubEntry]
        items.push({
          primary: pubEntry,
          bibEntries,
          year: Number(pubEntry.fields.year || 0),
          isStandaloneArxiv: false,
        })
      })
    }
  }

  // Group by year descending
  const byYear = new Map()
  for (const item of items) {
    if (!byYear.has(item.year)) byYear.set(item.year, [])
    byYear.get(item.year).push(item)
  }

  const years = Array.from(byYear.keys()).sort((a, b) => b - a)
  const out = []

  for (const year of years) {
    out.push(`## ${year}\n`)
    for (const { primary, bibEntries, isStandaloneArxiv } of byYear.get(year)) {
      const title = cleanLatex(primary.fields.title || "")
      const authors = formatAuthors(primary.fields.author || "")
      const venueStr = formatVenueText(primary)

      let extraLink = ""
      if (isStandaloneArxiv) {
        const arxivUrl =
          primary.fields.url ||
          (primary.fields.eprint ? `https://arxiv.org/abs/${primary.fields.eprint}` : "")
        if (arxivUrl) extraLink = ` | [arXiv](${arxivUrl})`
      }

      const detailsHtml = bibEntries
        .map((e) => {
          const label = bibEntries.length === 1 ? "[BibTeX]" : `[${getShortVenue(e)} BibTeX]`
          return `<details style="display: inline-block;"><summary style="display: inline; cursor: pointer;"><code>${label}</code></summary><pre><code>${formatBibtexBlock(e)}</code></pre></details>`
        })
        .join(" ")

      out.push(`- **${title}**  `)
      out.push(`  ${authors}  `)
      out.push(`  *${venueStr}*${extraLink} ${detailsHtml}\n`)
    }
  }

  return out.join("\n").trimEnd() + "\n"
}

// ---------- 4. Run ----------

const bibRaw = fs.readFileSync(BIB_PATH, "utf8")
const mdRaw = fs.readFileSync(MD_PATH, "utf8")

const markerIdx = mdRaw.indexOf(MARKER)
if (markerIdx === -1) {
  throw new Error(`Could not find marker "${MARKER}" in ${MD_PATH}`)
}

const header = mdRaw.slice(0, markerIdx + MARKER.length)
const entries = parseBibtex(bibRaw)
const generated = generateMarkdown(entries)

fs.writeFileSync(MD_PATH, `${header}\n\n${generated}`, "utf8")
console.log(`Updated ${MD_PATH} from ${entries.length} BibTeX entries.`)
