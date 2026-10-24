#!/usr/bin/env python3
"""Genera il PDF "Video arbitri Liga" per una settimana (lunedì–domenica).

Le gare LIGH/LIGD arrivano dal calendario pubblico VolleyAdmin (nessun login);
le designazioni VIDEO non sono pubbliche: si passano con --names (file di testo,
una riga per gara: "LIGH-06: PINTER PIERRE"). Senza --names il PDF è provvisorio
e la colonna VIDEO resta "da comunicare".

Uso:
  python3 tools/make_week_pdf.py                       # settimana corrente
  python3 tools/make_week_pdf.py --week 2026-10-19     # lunedì della settimana
  python3 tools/make_week_pdf.py --week 2026-10-19 --names designati.txt --final   # nomi ufficiali completi
  python3 tools/make_week_pdf.py --ligh cal-LIGH.xml --ligd cal-LIGD.xml   # XML già scaricati

Dipendenze: reportlab (pip install reportlab). Font DejaVu se presenti, altrimenti Helvetica.
"""
import argparse, datetime, os, re, subprocess, sys, urllib.request
import xml.etree.ElementTree as ET
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, KeepTogether
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

CAL_URL = "https://www.volleyadmin2.be/services/wedstrijden_xml.php?reeks={serie}"
IT_DAYS = ["lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato", "domenica"]
IT_MONTHS = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"]
FONT_DIR = "/usr/share/fonts/truetype/dejavu"


def fonts():
    reg, bold = os.path.join(FONT_DIR, "DejaVuSans.ttf"), os.path.join(FONT_DIR, "DejaVuSans-Bold.ttf")
    if os.path.exists(reg) and os.path.exists(bold):
        pdfmetrics.registerFont(TTFont("DV", reg)); pdfmetrics.registerFont(TTFont("DVB", bold))
        return "DV", "DVB"
    return "Helvetica", "Helvetica-Bold"


def fetch(serie):
    """Scarica il calendario; prova curl e urllib, accetta solo un XML <kalender> valido."""
    url = CAL_URL.format(serie=serie)
    attempts = [lambda: subprocess.run(["curl", "-sSL", url], check=True, capture_output=True, timeout=60).stdout,
                lambda: urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=30).read()]
    last = None
    for get in attempts:
        try:
            data = get()
            if b"<kalender" in data[:200]:
                return data
            last = f"risposta non XML ({data[:80]!r})"
        except Exception as e:
            last = str(e)
    sys.exit(f"download del calendario {serie} fallito: {last}")


def load(xml_bytes, serie, start, end):
    rows = []
    for w in ET.fromstring(xml_bytes).findall("wedstrijd"):
        g = lambda t: (w.findtext(t) or "").strip()
        d = datetime.datetime.strptime(g("datum"), "%d/%m/%Y").date()
        if start <= d <= end:
            rows.append(dict(serie=serie, date=d, time=g("aanvangsuur"), nr=g("nr"), home=g("thuisploeg"),
                             away=g("bezoekersploeg"), hall=g("sporthal"), postponed=g("postponed") == "1"))
    rows.sort(key=lambda r: (r["date"], r["time"], r["nr"]))
    return rows


def read_names(path):
    names = {}
    if not path:
        return names
    with open(path, encoding="utf-8") as f:
        for line in f:
            m = re.match(r"^\s*([A-Za-z]+-\d+)\s*[:;,\t]\s*(.+?)\s*$", line)
            if m:
                names[m.group(1).upper()] = m.group(2).upper()
    return names


def build(out_pdf, start, end, ligh, ligd, names, source_note, final=False):
    F, FB = fonts()
    NAVY, BLUE, GREY = colors.HexColor("#0E2350"), colors.HexColor("#2563EB"), colors.HexColor("#6B7280")
    LIGHT, RED, REDBG, REDBD = colors.HexColor("#F3F4F6"), colors.HexColor("#991B1B"), colors.HexColor("#FEF2F2"), colors.HexColor("#FCA5A5")
    GREENBG, GREENBD, GREEN = colors.HexColor("#F0FDF4"), colors.HexColor("#86EFAC"), colors.HexColor("#166534")

    def st(name, **kw):
        base = dict(fontName=F, fontSize=9, leading=12, textColor=NAVY); base.update(kw)
        return ParagraphStyle(name, **base)
    H1, H1s = st("h1", fontName=FB, fontSize=20, leading=24, textColor=colors.white), st("h1s", fontSize=10, leading=13, textColor=colors.HexColor("#DCE7FB"))
    H2, CELL, CELLB = st("h2", fontName=FB, fontSize=13, leading=16), st("cell"), st("cellb", fontName=FB)
    SMALL, BIG, LBL = st("small", fontSize=8, leading=10, textColor=GREY), st("big", fontName=FB, fontSize=22, leading=26, alignment=1), st("lbl", fontSize=8, leading=10, textColor=GREY, alignment=1)
    known = sum(1 for r in ligh + ligd if names.get(r["nr"]))
    provisional = (not final) and known < len(ligh) + len(ligd)
    without = len(ligh) + len(ligd) - known
    try:
        from zoneinfo import ZoneInfo
        gen = datetime.datetime.now(ZoneInfo("Europe/Brussels"))
    except Exception:
        gen = datetime.datetime.now().astimezone()

    def box(text, bg, bd, color):
        t = Table([[Paragraph(text, st("note", textColor=color))]], colWidths=[180 * mm])
        t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), bg), ("BOX", (0, 0), (-1, -1), 1, bd),
                               ("LEFTPADDING", (0, 0), (-1, -1), 10), ("RIGHTPADDING", (0, 0), (-1, -1), 10),
                               ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 8)]))
        return t

    header = Table([[Paragraph("VIDEO ARBITRI LIGA", H1)],
                    [Paragraph(f"Designazioni VIDEO – settimana {IT_DAYS[start.weekday()]} {start:%d/%m/%Y} – {IT_DAYS[end.weekday()]} {end:%d/%m/%Y}", H1s)]], colWidths=[180 * mm])
    header.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), BLUE), ("LEFTPADDING", (0, 0), (-1, -1), 14),
                                ("TOPPADDING", (0, 0), (0, 0), 14), ("BOTTOMPADDING", (0, 1), (0, 1), 14), ("ROUNDEDCORNERS", [8, 8, 8, 8])]))
    summary = Table([[Paragraph(str(len(ligh) + len(ligd)), BIG), Paragraph(str(len(ligh)), BIG), Paragraph(str(len(ligd)), BIG), Paragraph(str(known), BIG)],
                     [Paragraph("gare Liga nella settimana", LBL), Paragraph("LIGH · uomini", LBL), Paragraph("LIGD · donne", LBL), Paragraph("designati VIDEO noti", LBL)]], colWidths=[45 * mm] * 4)
    summary.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), LIGHT), ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#E5E7EB")),
                                 ("TOPPADDING", (0, 0), (-1, 0), 10), ("BOTTOMPADDING", (0, 1), (-1, 1), 10)]))
    if provisional:
        note = box("<b>Designazioni VIDEO non disponibili per tutte le gare.</b> Le designazioni ufficiali (VolleyAdmin – Alle Aanduidingen) sono visibili solo con login; "
                   "il calendario pubblico non le espone e il PDF settimanale su Drive viene prodotto solo a fine settimana. "
                   "Le gare con VIDEO «da comunicare» vanno completate con i nominativi del designatore: documento provvisorio.", REDBG, REDBD, RED)
    else:
        extra = f" {without} gare senza Video Referee designato." if without else ""
        note = box(f"<b>Designazioni VIDEO ufficiali:</b> {known} designati su {len(ligh) + len(ligd)} gare della settimana.{extra} Fonte: {source_note}.", GREENBG, GREENBD, GREEN)

    def match_table(rows):
        data = [[Paragraph(x, CELLB) for x in ["DATA", "ORA", "CODICE", "SQUADRE", "SALA", "VIDEO"]]]
        for r in rows:
            name = names.get(r["nr"])
            empty = "nessun designato" if final else "da comunicare"
            video = Paragraph(f"<b>{name}</b>", CELL) if name else Paragraph(f"<font color='#6B7280'>{empty}</font>", CELL)
            teams = f"{r['home']} – {r['away']}" + (" <font color='#991B1B'>(rinviata)</font>" if r["postponed"] else "")
            data.append([Paragraph(f"{IT_DAYS[r['date'].weekday()][:3]} {r['date']:%d/%m}", CELL), Paragraph(r["time"], CELL),
                         Paragraph(r["nr"], CELL), Paragraph(teams, CELL), Paragraph(r["hall"], SMALL), video])
        t = Table(data, colWidths=[20 * mm, 15 * mm, 20 * mm, 58 * mm, 37 * mm, 30 * mm], repeatRows=1)
        t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), LIGHT), ("LINEBELOW", (0, 0), (-1, 0), 0.8, NAVY),
                               ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#FAFAFA")]),
                               ("LINEBELOW", (0, 1), (-1, -1), 0.3, colors.HexColor("#E5E7EB")), ("VALIGN", (0, 0), (-1, -1), "TOP"),
                               ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                               ("LEFTPADDING", (0, 0), (-1, -1), 3), ("RIGHTPADDING", (0, 0), (-1, -1), 3)]))
        return t

    info_rows = [["Periodo", f"da {IT_DAYS[start.weekday()]} {start:%d} a {IT_DAYS[end.weekday()]} {end:%d} {IT_MONTHS[end.month - 1]} {end.year}"],
                 ["Fonte gare", "Calendario pubblico VolleyAdmin (wedstrijden_xml, serie LIGH e LIGD); serie SPC: feed pubblico vuoto"],
                 ["Fonte designazioni", source_note if names else "Nessuna fonte pubblica: da completare (VolleyAdmin con login, oppure comunicazione del designatore)"],
                 ["Generato", f"{gen:%d/%m/%Y} alle {gen:%H:%M} – Europe/Brussels"]]
    info = Table([[Paragraph(a, CELLB), Paragraph(b, CELL)] for a, b in info_rows], colWidths=[40 * mm, 140 * mm])
    info.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, -1), 0.3, colors.HexColor("#E5E7EB")), ("TOPPADDING", (0, 0), (-1, -1), 5),
                              ("BOTTOMPADDING", (0, 0), (-1, -1), 5), ("VALIGN", (0, 0), (-1, -1), "TOP")]))

    def footer(c, doc):
        c.saveState(); c.setFont(F, 7.5); c.setFillColor(GREY)
        c.drawString(15 * mm, 10 * mm, "Video Challenge BE · Calendario: VolleyAdmin · " + ("Designazioni VIDEO: da completare" if provisional else "Designazioni VIDEO: ufficiali"))
        c.drawRightString(195 * mm, 10 * mm, f"Pagina {doc.page}"); c.restoreState()

    doc = SimpleDocTemplate(out_pdf, pagesize=A4, leftMargin=15 * mm, rightMargin=15 * mm, topMargin=12 * mm, bottomMargin=16 * mm,
                            title=f"Video arbitri Liga – settimana {start:%d/%m} – {end:%d/%m/%Y}", author="Video Challenge BE")
    story = [header, Spacer(1, 8), summary, Spacer(1, 8), note, Spacer(1, 12),
             KeepTogether([Paragraph(f"LIGH · Liga uomini – {len(ligh)} gare", H2), Spacer(1, 4), match_table(ligh)]), Spacer(1, 12),
             KeepTogether([Paragraph(f"LIGD · Liga donne – {len(ligd)} gare", H2), Spacer(1, 4), match_table(ligd)]), Spacer(1, 14), info]
    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    return known, provisional


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--week", help="lunedì della settimana (AAAA-MM-GG); default: settimana corrente")
    ap.add_argument("--names", help="file di testo con le designazioni: una riga per gara, es. 'LIGH-06: PINTER PIERRE'")
    ap.add_argument("--source", default="designazioni comunicate dal designatore", help="testo della fonte delle designazioni (con --names)")
    ap.add_argument("--ligh", help="XML LIGH già scaricato (default: download)")
    ap.add_argument("--ligd", help="XML LIGD già scaricato (default: download)")
    ap.add_argument("--final", action="store_true", help="le designazioni in --names sono complete e ufficiali: le gare senza nome risultano 'nessun designato' e il PDF non è provvisorio")
    ap.add_argument("--out", help="percorso del PDF (default: 'Video arbitri Liga - settimana <inizio> - <fine>[ (provvisorio)].pdf')")
    a = ap.parse_args()
    today = datetime.date.today()
    start = datetime.date.fromisoformat(a.week) if a.week else today - datetime.timedelta(days=today.weekday())
    if start.weekday() != 0:
        sys.exit("--week deve essere un lunedì")
    end = start + datetime.timedelta(days=6)
    ligh_xml = open(a.ligh, "rb").read() if a.ligh else fetch("LIGH")
    ligd_xml = open(a.ligd, "rb").read() if a.ligd else fetch("LIGD")
    ligh, ligd = load(ligh_xml, "LIGH", start, end), load(ligd_xml, "LIGD", start, end)
    names = read_names(a.names)
    unknown = sorted(set(names) - {r["nr"] for r in ligh + ligd})
    if unknown:
        print("ATTENZIONE: codici in --names non presenti nel calendario della settimana:", ", ".join(unknown), file=sys.stderr)
    known_tmp = sum(1 for r in ligh + ligd if names.get(r["nr"]))
    provisional = (not a.final) and known_tmp < len(ligh) + len(ligd)
    out = a.out or f"Video arbitri Liga - settimana {start} - {end}{' (provvisorio)' if provisional else ''}.pdf"
    known, provisional = build(out, start, end, ligh, ligd, names, a.source, a.final)
    print(f"scritto: {out} | gare LIGH {len(ligh)}, LIGD {len(ligd)} | designati noti {known}" + (" | PROVVISORIO" if provisional else ""))


if __name__ == "__main__":
    main()
