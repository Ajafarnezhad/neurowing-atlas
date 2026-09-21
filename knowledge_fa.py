# -*- coding: utf-8 -*-
"""
Persian explanatory layer for FlyBrain Lab.

These descriptions are *interpretive aids*. They never replace the original
dataset annotations. The API reports the evidence and confidence explicitly.
"""
import re

RULES = [
    (r"\bAPL\b|anterior paired lateral",
     "APL", "نورون APL در مدار Mushroom Body یک نورون بازخوردی گسترده است و معمولاً با تنظیم/مهار جمعیت‌های Kenyon Cell و کنترل sparsity فعالیت مرتبط دانسته می‌شود.",
     ["حافظه", "بازخورد", "تنظیم فعالیت"], "بالا"),
    (r"\bDPM\b|dorsal paired medial",
     "DPM", "DPM با مدار Mushroom Body و تثبیت/بازیابی حافظه ارتباط دارد و اتصالات بازگشتی گسترده با Kenyon Cellها و مدارهای مرتبط می‌تواند فعالیت را در طول زمان شکل دهد.",
     ["حافظه", "بازگشت زمانی", "Mushroom Body"], "بالا"),
    (r"\bMBON\b",
     "MBON", "MBON خروجی Mushroom Body است. این نورون‌ها فعالیت Kenyon Cellها را به سیگنال‌های تصمیم، ارزش‌گذاری و رفتار تبدیل می‌کنند.",
     ["خروجی حافظه", "ارزش‌گذاری", "تصمیم"], "بالا"),
    (r"\bKC\b|kenyon",
     "Kenyon Cell", "Kenyon Cellها نورون‌های اصلی Mushroom Body هستند. نمایش‌های حسی sparse و ترکیبی می‌سازند و بستر مهمی برای یادگیری تداعی‌گر فراهم می‌کنند.",
     ["نمایش sparse", "یادگیری تداعی‌گر", "حافظه"], "بالا"),
    (r"\bDAN\b|\bPAM\b|\bPPL\b|dopamin",
     "Dopaminergic / Modulatory", "این گروه معمولاً نقش تعدیل‌کننده دارد و می‌تواند سیگنال‌های پاداش، تنبیه یا خطای پیش‌بینی را به مدارهای یادگیری منتقل کند.",
     ["پاداش/تنبیه", "Plasticity", "یادگیری"], "متوسط"),
    (r"\bORN\b|olfactory receptor|olfactory",
     "Olfactory sensory", "این نورون/گروه با مسیر بویایی مرتبط است و اطلاعات شیمیایی محیط را به مدارهای مرکزی منتقل می‌کند.",
     ["حس بویایی", "ورودی حسی"], "متوسط"),
    (r"projection neuron|\bPN\b",
     "Projection neuron", "Projection neuron معمولاً اطلاعات را از یک ناحیه حسی به نواحی پردازشی بالاتر منتقل می‌کند و نقش relay/feature transport دارد.",
     ["انتقال حسی", "Feature relay"], "متوسط"),
    (r"photoreceptor|visual|lamina|medulla|lobula|optic",
     "Visual pathway", "برچسب‌ها نشان می‌دهند این نورون در مسیر بینایی/لوب‌های بینایی قرار دارد و احتمالاً در استخراج یا انتقال ویژگی‌های بصری مشارکت می‌کند.",
     ["بینایی", "پردازش ویژگی"], "متوسط"),
    (r"descending|\bDN\b",
     "Descending neuron", "Descending neuron پلی میان پردازش مغز و مدارهای حرکتی پایین‌دست است و می‌تواند فرمان‌های رفتاری را به سیستم موتور منتقل کند.",
     ["خروجی حرکتی", "فرمان رفتار"], "متوسط"),
    (r"motor|steering|wing|leg",
     "Motor-related", "این برچسب با کنترل حرکتی مرتبط است. برای تعیین نقش دقیق باید مسیرهای پایین‌دست، عضله/ناحیه هدف و شواهد annotation بررسی شوند.",
     ["حرکت", "خروجی"], "متوسط"),
    (r"ring neuron|ellipsoid|central complex|fan-shaped|\bEB\b|\bFB\b",
     "Central Complex", "این نورون احتمالاً به Central Complex مربوط است؛ سامانه‌ای که با جهت‌یابی، وضعیت داخلی، انتخاب عمل و ناوبری ارتباط دارد.",
     ["ناوبری", "جهت‌یابی", "انتخاب عمل"], "متوسط"),
    (r"mechan|chordotonal|bristle|touch",
     "Mechanosensory", "برچسب‌ها با ورودی مکانیکی/لمسی سازگارند و می‌توانند اطلاعات تماس، ارتعاش یا وضعیت بدن را وارد شبکه کنند.",
     ["لمس", "حس مکانیکی"], "متوسط"),
]

def explain_neuron_fa(root_id, labels=None, processed=None, tags=None,
                      neuropils=None, stats=None, nt_profile=None):
    labels=labels or []; processed=processed or []; tags=tags or []
    text=" ".join(
        [str(x.get("label",""))+" "+str(x.get("details","")) for x in labels if isinstance(x,dict)]
        + [str(x) for x in processed] + [str(x) for x in tags]
    )
    hit=None
    for rx,name,summary,roles,conf in RULES:
        if re.search(rx,text,re.I):
            hit=(name,summary,roles,conf);break

    if hit:
        name,summary,roles,conf=hit
    else:
        name="نورون Connectome"
        roles=[]
        conf="پایین"
        summary=("برای این Root ID توضیح عملکردی صریحی از روی Labelهای موجود پیدا نشد. "
                 "در این حالت بهتر است نقش نورون از الگوی ورودی/خروجی، Neuropilها، "
                 "Neurotransmitter و مسیرهای متصل استنباط شود.")

    stats=stats or {}
    evidence=[]
    if stats:
        evidence.append(
            f"{int(stats.get('input_partners',0)):,} شریک ورودی و "
            f"{int(stats.get('output_partners',0)):,} شریک خروجی"
        )
    if tags:
        evidence.append("Tagها: "+", ".join(map(str,tags[:6])))
    if neuropils and neuropils.get("found"):
        topi=[x["neuropil"] for x in neuropils.get("inputs",[])[:3]]
        topo=[x["neuropil"] for x in neuropils.get("outputs",[])[:3]]
        if topi: evidence.append("ورودی غالب: "+", ".join(topi))
        if topo: evidence.append("خروجی غالب: "+", ".join(topo))
    if nt_profile:
        top=sorted(nt_profile.items(),key=lambda kv:kv[1],reverse=True)[:3]
        if top: evidence.append("NT خروجی تقریبی: "+", ".join(f"{k} {v:.0f}" for k,v in top))

    return {
        "root_id": str(root_id),
        "role_name": name,
        "summary_fa": summary,
        "roles": roles,
        "confidence": conf,
        "evidence": evidence,
        "caveat": "این متن یک لایه توضیحی خودکار بر پایه annotation و topology است؛ ادعای عملکرد قطعی زیستی نیست."
    }
