# ساختار دیتاست مورد استفاده پروژه

پروژه پوشه ریشه را recursive اسکن می‌کند. برای ساختاری که در دیتاست فعلی استفاده می‌شود:

```text
A:\flybrain\
├── connections_buhmann_no_threshold.csv\
│   └── connections_no_threshold.csv
├── connections_princeton.csv\
│   └── connections_princeton.csv
├── connections_princeton_no_threshold.csv\
│   └── connections_no_threshold.csv
├── connectivity_tags.csv\
│   └── connectivity_tags.csv
├── coordinates.csv\
│   └── coordinates.csv
├── fafb_v783_princeton_synapse_table.csv\
│   └── fafb_v783_princeton_synapse_table.csv
├── labels.csv\
│   └── labels.csv
├── neuropil_synapse_table.csv\
│   └── neuropil_synapse_table.csv
├── processed_labels.csv\
│   └── processed_labels.csv
└── sk_lod1_783_healed\
    └── *.swc
```

## نقش هر بخش

### connections_*
گراف directed نورون‌ها:

```text
pre_root_id → post_root_id
```

با `syn_count` به‌عنوان وزن ساختاری اولیه.

### labels / processed_labels
Annotation و متن‌های مربوط به Root IDها.

### connectivity_tags
ویژگی‌های graph مانند reciprocal / rich-club و سایر tagهای موجود در دیتاست.

### coordinates
موقعیت‌های مرتبط با Root ID. اگر مختصات در یک ستون `position` باشند، backend آن‌ها را parse می‌کند.

### Princeton synapse table
مختصات pre/post سیناپس‌ها و neuropil مربوط به اتصال.

### neuropil_synapse_table
آمار ورودی/خروجی هر Root ID در نواحی مختلف مغز.

### SWC
مورفولوژی واقعی نورون به صورت:

```text
node_id type x y z radius parent
```

SWC خام برای نمایش دقیق نورون انتخاب‌شده استفاده می‌شود. برای نمایش کل مغز، پروژه یک Atlas LOD جداگانه می‌سازد.
