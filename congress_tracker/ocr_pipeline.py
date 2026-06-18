"""
PDF text and OCR extraction for official Congressional PTR filings.

The first pass uses embedded PDF text through pdfplumber. OCR is attempted only
when extracted text is too sparse, and failures are returned as structured
warnings so the pipeline can continue safely.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path

import pdfplumber

try:
    import pytesseract
except ImportError:  # pragma: no cover - optional runtime dependency
    pytesseract = None

MIN_TEXT_CHARS_PER_PAGE = 80


@dataclass(frozen=True)
class PageText:
    page_number: int
    text: str
    extraction_method: str


@dataclass(frozen=True)
class TextExtractionResult:
    file_path: str
    pages: list[PageText] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def full_text(self) -> str:
        return "\n\n".join(page.text for page in self.pages if page.text.strip())


def extract_text_from_pdf(path: Path, *, enable_ocr: bool = True) -> TextExtractionResult:
    logger = logging.getLogger("CongressOCR")
    warnings: list[str] = []
    pages: list[PageText] = []

    try:
        with pdfplumber.open(path) as pdf:
            for index, page in enumerate(pdf.pages, start=1):
                text = (page.extract_text() or "").strip()

                if len(text) >= MIN_TEXT_CHARS_PER_PAGE or not enable_ocr:
                    pages.append(PageText(index, text, "pdf_text"))
                    continue

                ocr_text = ""
                if pytesseract is None:
                    warnings.append(f"Page {index}: OCR requested but pytesseract is unavailable.")
                else:
                    try:
                        image = page.to_image(resolution=200).original
                        ocr_text = pytesseract.image_to_string(image).strip()
                    except Exception as exc:  # noqa: BLE001 - OCR must fail soft
                        warnings.append(f"Page {index}: OCR failed safely: {exc}")
                        logger.warning("OCR failed for %s page %s: %s", path, index, exc)

                pages.append(PageText(index, ocr_text or text, "ocr" if ocr_text else "pdf_text_sparse"))
    except Exception as exc:  # noqa: BLE001 - malformed PDFs should not kill the job
        warnings.append(f"PDF extraction failed safely: {exc}")
        logger.exception("PDF extraction failed safely for %s", path)

    return TextExtractionResult(str(path), pages, warnings)
