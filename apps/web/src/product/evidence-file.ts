import { t } from '../i18n';
/** Preserve the entire source or reject it; a truncated source is not evidence. */
export async function readEvidenceFile(file: Pick<File, 'size' | 'text'>): Promise<string> {
    if (file.size > 80000)
        throw new Error(t("The file is too large. Use a text file no larger than 80 KB."));
    let body: string;
    try {
        body = await file.text();
    }
    catch {
        throw new Error(t("This file could not be read. Select another file or paste its text directly."));
    }
    if (body.length > 20000)
        throw new Error(t("The text exceeds 20,000 characters. Split it into complete sections before importing; original evidence is never silently truncated."));
    return body;
}
