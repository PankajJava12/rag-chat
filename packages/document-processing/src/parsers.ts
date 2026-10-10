import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mammoth from "mammoth";
import ExcelJS from "exceljs";
import { load } from "cheerio";
import { parse } from "csv-parse/sync";
import { AppError } from "../../shared/src/errors.js";
import type { FileType } from "./validate.js";
const run = promisify(execFile);
export interface ParsedSection {
  text: string;
  pageNumber?: number;
  sectionTitle?: string;
  sheetName?: string;
  rowStart?: number;
  rowEnd?: number;
  kind: "paragraph" | "table" | "ocr";
}
function tableRows(rows: string[][], sheetName?: string): ParsedSection[] {
  if (rows.length > 50000) throw new AppError("TOO_MANY_ROWS");
  const headers = rows[0]?.map((v, i) => v || `Column ${i + 1}`) ?? [];
  return rows.slice(1).map((row, i) => ({
    text: row
      .map(
        (value, column) =>
          `${headers[column] ?? `Column ${column + 1}`}: ${value}`,
      )
      .join(" | "),
    sheetName,
    rowStart: i + 2,
    rowEnd: i + 2,
    kind: "table" as const,
  }));
}
async function pdf(data: Buffer): Promise<ParsedSection[]> {
  const directory = await mkdtemp(join(tmpdir(), "advisor-pdf-"));
  try {
    const path = join(directory, "source.pdf");
    await writeFile(path, data, { mode: 0o600 });
    const info = (
      await run("pdfinfo", [path], { timeout: 15000, maxBuffer: 1024 * 1024 })
    ).stdout;
    const pages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
    if (!pages || pages > 100) throw new AppError("PDF_PAGE_LIMIT");
    const sections: ParsedSection[] = [];
    for (let page = 1; page <= pages; page++) {
      const text = (
        await run(
          "pdftotext",
          [
            "-f",
            String(page),
            "-l",
            String(page),
            "-layout",
            "-enc",
            "UTF-8",
            path,
            "-",
          ],
          { timeout: 20000, maxBuffer: 2 * 1024 * 1024 },
        )
      ).stdout.trim();
      if (text.length >= 30)
        sections.push({ text, pageNumber: page, kind: "paragraph" });
      else {
        const prefix = join(directory, `page-${page}`);
        await run(
          "pdftoppm",
          [
            "-f",
            String(page),
            "-l",
            String(page),
            "-scale-to",
            "2400",
            "-singlefile",
            "-png",
            path,
            prefix,
          ],
          { timeout: 30000, maxBuffer: 1024 * 1024 },
        );
        const ocr = (
          await run("tesseract", [`${prefix}.png`, "stdout", "-l", "eng"], {
            timeout: 30000,
            maxBuffer: 2 * 1024 * 1024,
          })
        ).stdout.trim();
        if (ocr) sections.push({ text: ocr, pageNumber: page, kind: "ocr" });
      }
    }
    return sections;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("PDF_EXTRACTION_FAILED");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export async function parseDocument(
  data: Buffer,
  type: FileType,
): Promise<ParsedSection[]> {
  let sections: ParsedSection[] = [];
  if (type === "pdf") sections = await pdf(data);
  if (type === "docx") {
    const converted = await mammoth.convertToHtml(
      { buffer: data },
      { externalFileAccess: false },
    );
    const $ = load(converted.value);
    let title: string | undefined;
    $("body")
      .children()
      .each((_i, element) => {
        const node = $(element),
          tag = element.tagName;
        if (/^h[1-6]$/.test(tag)) {
          title = node.text().trim();
        }
        if (tag === "table") {
          const rows: string[][] = [];
          node.find("tr").each((_r, tr) => {
            rows.push(
              $(tr)
                .find("th,td")
                .map((_c, cell) => $(cell).text().trim())
                .get(),
            );
          });
          sections.push(
            ...tableRows(rows).map((section) => ({
              ...section,
              sectionTitle: title,
            })),
          );
        } else {
          const text = node.text().trim();
          if (text)
            sections.push({ text, sectionTitle: title, kind: "paragraph" });
        }
      });
  }
  if (type === "xlsx") {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(data as unknown as ExcelJS.Buffer);
    if (workbook.worksheets.length > 50) throw new AppError("TOO_MANY_SHEETS");
    for (const sheet of workbook.worksheets) {
      if (sheet.rowCount > 50000 || sheet.columnCount > 200)
        throw new AppError("WORKSHEET_LIMIT");
      let headers: string[] | undefined;
      sheet.eachRow((row, rowNumber) => {
        const cells: string[] = [];
        for (let column = 1; column <= sheet.columnCount; column++) {
          const cell = row.getCell(column);
          const value = cell.value;
          cells.push(
            value instanceof Date
              ? value.toISOString().slice(0, 10)
              : typeof value === "object" && value && "formula" in value
                ? value.result === undefined
                  ? "[formula has no cached value]"
                  : String(value.result)
                : cell.text,
          );
        }
        if (!headers) {
          headers = cells;
          return;
        }
        sections.push({
          text: cells
            .map((v, i) => `${headers![i] || `Column ${i + 1}`}: ${v}`)
            .join(" | "),
          sheetName: sheet.name,
          rowStart: rowNumber,
          rowEnd: rowNumber,
          kind: "table",
        });
      });
    }
  }
  if (type === "csv") {
    try {
      let count = 0;
      const rows = parse(data, {
        bom: true,
        skip_empty_lines: true,
        max_record_size: 65536,
        relax_column_count: false,
        on_record(record) {
          if (++count > 50001) throw new AppError("TOO_MANY_ROWS");
          return record;
        },
      }) as string[][];
      sections = tableRows(rows);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("INVALID_CSV");
    }
  }
  sections = sections
    .map((s) => ({
      ...s,
      text: s.text
        .normalize("NFC")
        .replace(/\r\n/g, "\n")
        .replaceAll(String.fromCharCode(0), "")
        .trim(),
    }))
    .filter((s) => s.text);
  if (!sections.length) throw new AppError("NO_EXTRACTABLE_TEXT");
  if (sections.reduce((n, s) => n + s.text.length, 0) > 4 * 1024 * 1024)
    throw new AppError("EXTRACTED_TEXT_LIMIT");
  return sections;
}
