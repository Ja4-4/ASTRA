# ASTRA backend — Rust (axum + SQLite)

بيانات تجريبية فقط. ليس جهازاً تشخيصياً ولا بديلاً عن الـ flight surgeon.

## التشغيل
```bash
cargo run --release -- seed      # يحمّل قصة العرض من history.raw.json (كل صف موسوم "simulated")
cargo run --release -- serve     # http://127.0.0.1:8000  (الواجهة على /  والـ API على /api)
cargo test
```
`serve` على قاعدة بيانات فارغة يشغّل `seed` ويستورد ملفات المقصورة الجاهزة في `data/raw/eda/` مرة واحدة، ثم يطبع سطرين
بما حُمّل فعلاً. إن لم توجد ملفات مقصورة يكتب "not available" ولا يختلق شيئاً.
يحتاج Rust (rustup). SQLite مدمجة في البرنامج، لكن على Windows يلزم Visual Studio Build Tools (مترجم C).
يُشغَّل دائماً من مجلد المشروع (يقرأ `static/` و`mappings/` و`data/` نسبةً إليه).

## قصة عرض واحدة (Demo) مشتركة مع الواجهة
`seed` لا يولّد أرقاماً. يقرأ `data/demo/history.raw.json`، وهو نسخة ينسخها `build.rs` عند كل بناء من
`frontend/src/data/demo/history.raw.json` (265 قراءة، 30 يوماً حتى Mission Day 142). رائد العرض هو
`Cmdr. Layla Haddad` (شخصية خيالية، `is_synthetic = 1`) كما في `frontend/src/data/demo/profile.ts`.
القراءات الناقصة في الملف تبقى ناقصة (مثلاً لا حرارة جسم بعد 10 نوفمبر).

جدول الرموز والوحدات والحالات في قسم "Frontend integration (pending)" آخر هذا الملف.

## إضافة واجهة HTML (الفرونت إند)
ضع ملفاتك داخل `static/` وسيقدّمها الخادم كما هي: `index.html` على `/` ومعه أي `css/` أو `js/` أو صور
في مجلدات فرعية. لا حاجة لإعادة بناء الـ Rust عند تعديل الواجهة، فقط حدّث الصفحة.
صفحات التجربة القديمة انتقلت إلى `static/dev/` (تُفتح على `/dev/` و`/dev/test.html`)، و`static/index.html` صار ملكاً لبناء الواجهة (frontend build).
والـ API يعمل بـ CORS مفتوح، فيمكن للواجهة أن تعمل من مكان آخر (مثل Live Server) وتنادي `http://127.0.0.1:8000/api/...`.

## الـ API (كلها تحت /api)
`GET /health` · `GET /indicators` · `GET|POST /astronauts` · `GET|POST /measurements` · `GET /overview/{id}` ·
`GET /trends?astronaut_id=&indicator_code=&days=` · `GET /alerts?astronaut_id=` · `POST /alerts/{id}/acknowledge` ·
`GET|POST /events` · `GET /events/{id}` · `POST /follow-ups/{id}/complete` · `GET /routines?astronaut_id=` ·
`POST /routines/{id}/complete` · `GET /environment` · `GET /evidence` ·
`GET /import/files` · `POST /import?csv_file=&mapping=` · `GET /import/log`

## إضافة ملفات التحدي وتنظيفها
1. ضع الـ CSV في `data/raw/`
2. `cargo run --release -- inspect data/raw/<file>.csv` (الأعمدة والأنواع والفراغات)
3. انسخ أقرب مثال من `mappings/` (wide / long / environment) وعدّل أسماء الأعمدة والوحدات
4. جرّب بدون كتابة: `cargo run --release -- import data/raw/<file>.csv mappings/<m>.json --dry-run`
5. استورد: `cargo run --release -- import data/raw/<file>.csv mappings/<m>.json`

الناتج: نسخة منظفة في `data/clean/<file>.clean.csv` + البيانات في قاعدة البيانات + تقرير (المرفوض والناقص والمحوَّل).

ما ينظفه: BOM والمسافات في العناوين، القيم الناقصة (`N/A` و`-` وفارغ) تبقى ناقصة ولا تُختلق، الفاصلة العشرية،
اكتشاف الفاصل (`,` `;` Tab)، توحيد الوقت إلى UTC، تحويل الوحدات (°F→°C، mmol/L→mg/dL، دقائق→ساعات)،
حذف المكرر، رفض التواريخ الخاطئة والقيم المستحيلة فيزيائياً، ووسم القيم ذات الوحدة غير المذكورة بـ `suspect`.
إعادة استيراد نفس الملف آمنة (لا تكرار).

## ملاحظات للفريق
- عتبات التنبيه في `alert_rules` **مؤقتة** (`reviewed=0`) ويجب أن يراجعها الشريك رقم 3 قبل العرض.
- `evidence_sources`: عبّئ الروابط والتراخيص من القسم 8 في الدليل قبل التسليم.
- صفحة التحدي الرسمية (تبويب Resources) تحوي مقالات فقط ولا ملفات CSV: nasa.gov/hrp/hazards و/risks و/ongoing-hrp-research ومقالتا CSA.
- الأسماء المستوردة (`subject_1`…) يجب أن تكون مجهولة الهوية؛ لا تدخل بيانات صحية حقيقية لأشخاص.
- ملفات `mappings/example_*.json` أمثلة فقط؛ لم تُكتب بعد رؤية أعمدة الملفات الحقيقية.

## بيانات ISS الحقيقية (NASA OSDR – Environmental Data App) والنموذج المرجعي

مصدر البيانات: واجهة EDA العامة (`https://visualization.osdr.nasa.gov/eda/api/`) – 24 مهمة، سحبنا منها بيانات المقصورة (حرارة، رطوبة، CO₂) والإشعاع.
**الترخيص: لم يُراجَع بعد** – راجعوا شروط OSDR قبل التسليم: https://www.nasa.gov/reference/osdr-help-terms-and-conditions/

التشغيل (بدون إنترنت وبدون `pip install`؛ السكربتات تستخدم مكتبة Python القياسية فقط):

```
python3 -I scripts/prepare_eda.py       # تنظيف ⇒ data/raw/eda/ + data/clean/eda_prepare_report.json
python3 -I scripts/train_env_model.py   # تدريب ⇒ models/env_baseline.json
python3 -I scripts/load_eda.py          # الاثنان معاً ثم الاستيراد إلى قاعدة البيانات (يحتاج cargo build --release)
```

الملف المصدر محفوظ في المستودع: `data/raw/eda_telemetry_all_missions.csv.gz` (746,276 صفاً، 19 مهمة).

**ملف ناقص:** `data/raw/eda_radiation_all_missions.csv` غير موجود في المستودع. إلى أن يُضاف، بيانات الإشعاع
تبقى "not available" والسكربتات تتخطاها دون خطأ. يكفي وضع الملف بهذا الاسم في `backend/data/raw/` ثم إعادة تشغيل
`scripts/load_eda.py`. ملفات `mappings/eda/*_radiation.json` باقية كما هي لهذا الغرض.

ما يفعله التنظيف (`scripts/prepare_eda.py`)، وكل قاعدة لها عدّاد لكل مهمة في `data/clean/eda_prepare_report.json`:
- أعمدة `*_iss_*` فقط؛ أعمدة المختبر الأرضي (Ground) لا تدخل لأنها ليست قياسات المحطة.
- دمج الصفوف التي تشترك في (mission, time_utc): 111,726 صفاً (أغلبها في RR-7 وRR-10 وRR-18 حيث كل حساس في صف).
  إذا اختلفت قيمتان لنفس العمود تصبح القيمة "not available" (حالتان، كلتاهما حرارة في RR-20).
- رطوبة خارج 0–100% ⇒ تُحذف (1,434 قراءة، كلها في RR-18).
- CO₂ أقل من 300 ppm ⇒ يُعلَّم "suspect" (2,274 قراءة: RR-7 ‏1,450، RR-3 ‏823، RR-19 ‏1). السبب: القيمة أقل من
  هواء الأرض الخارجي، ومقصورة مغلقة فيها طاقم لا تصل إليها. القراءة تبقى في مكانها والعمود `co2_iss_ppm_quality`
  يقول "suspect"؛ تُخزَّن في `env_readings` بـ `quality = suspect` وتظهر هكذا في `GET /api/environment`،
  والنموذج لا يستخدمها.
- لا استيفاء ولا اختلاق قيم؛ الفراغ = "not available" ولا يُخزَّن صف.
- ملف مصدر لكل مهمة (`source_name` مختلف) كي لا تتصادم المهمات المتداخلة زمنياً.

### تغطية البيانات لكل مهمة

هذه **قراءات مقصورة** (حرارة، رطوبة، CO₂) سُجّلت على المحطة خلال فترات تجارب Rodent Research.
**ليست بيانات صحية لرواد الفضاء.** مهمات Veggie وAPEX موجودة في الملف المصدر لكن أعمدتها كلها فارغة، فلا تدخل
قاعدة البيانات ولا النموذج. الصياغة المعتمدة في كل الوثائق والعرض:
"ISS cabin data from 14 Rodent Research missions (NASA OSDR)".

| Mission | Period with ISS data (UTC) | Source rows | Temp readings | Humidity readings | CO₂ readings | Humidity dropped | CO₂ suspect |
|---|---|---:|---:|---:|---:|---:|---:|
| RR-1 | 2014-09-20 to 2014-11-01 | 12,087 | 12,087 | 12,087 | 12,087 | 0 | 0 |
| RR-3 | 2016-04-08 to 2016-05-28 | 14,385 | 14,385 | 14,385 | 13,562 | 0 | 823 |
| RR-5 | 2017-06-01 to 2017-08-08 | 19,160 | 19,160 | 19,160 | 19,160 | 0 | 0 |
| RR-6 | 2017-12-06 to 2018-02-06 | 17,572 | 17,572 | 17,572 | 17,572 | 0 | 0 |
| RR-7 | 2018-07-01 to 2018-09-18 | 43,898 | 21,948 | 21,948 | 20,498 | 0 | 1,450 |
| RR-9 | 2018-08-14 to 2018-09-18 | 10,079 | 10,079 | 10,079 | 10,079 | 0 | 0 |
| RR-10 | 2020-12-04 to 2021-01-03 | 86,206 | 43,102 | 43,102 | 38,112 | 0 | 0 |
| RR-12 | 2019-04-17 to 2019-05-28 | 11,785 | 11,785 | 11,785 | 11,785 | 0 | 0 |
| RR-18 | 2021-12-20 to 2022-02-28 | 147,464 | 100,800 | 99,366 | not available | 1,434 | 0 |
| RR-19 | 2019-12-03 to 2020-01-07 | 10,193 | 10,193 | 10,193 | 10,192 | 0 | 1 |
| RR-20 | 2023-11-21 to 2024-01-07 | 67,976 | 52,587 | not available | not available | 0 | 0 |
| RR-23 | 2020-12-09 to 2021-01-15 | 52,599 | 48,357 | 48,357 | 43,508 | 0 | 0 |
| RR-25 | 2022-11-29 to 2023-02-02 | 93,763 | 83,021 | not available | not available | 0 | 0 |
| RR-28 | 2024-03-24 to 2024-05-06 | 61,488 | 55,578 | not available | not available | 0 | 0 |
| VEG-01A | not available | 8,545 | not available | not available | not available | 0 | 0 |
| VEG-01C | not available | 80,388 | not available | not available | not available | 0 | 0 |
| APEX-03-1 | not available | 2,717 | not available | not available | not available | 0 | 0 |
| APEX-03-2 | not available | 2,430 | not available | not available | not available | 0 | 0 |
| APEX-04 | not available | 3,541 | not available | not available | not available | 0 | 0 |

المجموع بعد التنظيف: 500,654 قراءة حرارة (14 مهمة)، 308,034 رطوبة (11 مهمة)، 196,555 CO₂ ‏(10 مهمات).

النموذج (`scripts/train_env_model.py` ⇒ `models/env_baseline.json`): نطاقات مرجعية قوية (median/MAD + نِسَب مئوية 1–99 و0.1–99.9) تُتعلَّم من بيانات ISS الحقيقية، مع تحقق leave-one-mission-out في `data/clean/env_model_validation.json`.

| Parameter | n | Median | MAD | Watch band (1–99%) | Alert band (0.1–99.9%) | Leave-one-mission-out watch rate (median / max) |
|---|---:|---:|---:|---|---|---|
| cabin_temp (°C) | 500,654 | 22.63 | 0.47 | 20.4 – 24.2 | 18.9 – 26.6 | 0.026 / 0.195 (RR-3) |
| humidity (%) | 308,034 | 41.0 | 4.0 | 34.0 – 79.44 | 31.0 – 97.72 | 0.009 / 0.134 (RR-18) |
| co2 (ppm) | 196,555 | 2511 | 481 | 1469 – 6474 | 500 – 8282.78 | 0.001 / 0.102 (RR-7) |

المعدّل المتوقع لو كانت المهمات متشابهة هو 0.02. نقاط ضعف ظاهرة ولم نخفِها: RR-3 أبرد من باقي المهمات، وكل قراءات الرطوبة فوق 79% تأتي من RR-18 وحدها (3% من قراءاتها) فهي التي ترفع الحد الأعلى للرطوبة، وحدّ CO₂ الأدنى (500 ppm) يساوي أدنى قيمة مسجّلة في RR-6
وRR-12 بالضبط، وقد يكون حدّ قراءة الحساس وليس قيمة حقيقية.
هو **مرجع إحصائي لا حد أمان ولا تشخيص**؛ والتقييم يشرح القاعدة التي انطلقت:

```
GET /api/environment/model
GET /api/environment/assess?parameter=co2&value=7000    # co2 | cabin_temp | humidity
```

## فحص العين بالكاميرا (`src/eye.rs` — ملف رست واحد)

```
cargo run --release -- serve
# ثم افتح  http://localhost:8000/eye   (يحتاج إنترنت أول مرة لتحميل نموذج MediaPipe + إذن الكاميرا)
```

كيف يعمل: الخادم لا يستطيع فتح كاميرتك، فالصفحة `/eye` (مضمَّنة في الملف) تفتحها في المتصفح وتشغّل نموذج **Google MediaPipe FaceLandmarker الجاهز** داخل المتصفح (معالم الوجه والقزحية + درجات الرمش)،
وترسل للخادم أرقاماً مختصرة + صورة ثابتة واحدة فقط (الفيديو لا يغادر الجهاز). كل التحليل يتم في رست:

- **الإرهاق:** PERCLOS، معدل الرمش، الرمشات البطيئة (>400 ms)، الغفوات الدقيقة (≥1 s)، + ساعات النوم المسجَّلة في قاعدة البيانات (إن وُجدت وكانت حديثة).
- **علامات ظاهرة (ثقة منخفضة):** مؤشر انحراف العينين (vergence) بعد إزالة ميلان الرأس، فرق الارتفاع، اختلاف فتحة الجفنين، اختلاف حجم القزحية، احمرار/اصفرار بياض العين **مقارنةً بخط الأساس للرائد نفسه** (يلزم ٣ التقاطات على الأقل).
- كل حكم يعرض `rules_fired` (القاعدة، القيمة، الحد، المصدر) وحالة `ok | watch | attention`. نقص البيانات ⇒ "not available" ولا يُخمَّن شيء.

```
POST /api/eye/analyze     GET /api/eye/history?astronaut_id=1     GET /api/eye/model
```

**حدود صريحة:**
- لا يوجد نموذج "مدرَّب على بيانات أمراض العين" هنا، ولا يسمّي أمراضاً (إعتام، جلوكوما، اعتلال الشبكية، متلازمة SANS)؛ هذه تحتاج تصوير قاع العين/OCT وفحصاً سريرياً، والكاميرا لا تكفي.
- جميع العتبات مبدئية (`reviewed=false`) ويجب أن يراجعها شريك سريري قبل أي استخدام.
- اختُبر المنطق بمعالم وجه اصطناعية (اختبارات الوحدة + طلبات HTTP حقيقية)؛ **واجهة الكاميرا لم تُجرَّب بكاميرا حقيقية** في بيئة التطوير.
- ليس تشخيصاً طبياً.

## Frontend integration (pending)

لم يُربط الفرونت إند بالـ API بعد: التصميم لم يُعتمد، ولا يوجد أي تعديل تحت `frontend/`. هذا القسم هو العقد الجاهز
لوقت الربط. الـ backend يقرأ ملفاً واحداً فقط من الفرونت إند: `frontend/src/data/demo/history.raw.json` (ينسخه `build.rs`).

### Indicator codes and units

المصدر: `METRIC_CODES` في `src/seed.rs`. اختبار `metric_codes_match_the_frontend_and_the_indicator_table` يتحقق منه
مقابل `frontend/src/data/adapter.ts` و`GET /api/indicators`.

| Frontend metric (`history.raw.json`) | Frontend `IndicatorId` | Backend `indicator_code` | Frontend unit | Backend unit | Plausible range (rejects corrupt data, not clinical) |
|---|---|---|---|---|---|
| HR_REST | hr | heart_rate | bpm | bpm | 20 – 250 |
| BP_SYS | bp_sys | bp_systolic | mmHg | mmHg | 50 – 280 |
| BP_DIA | bp_dia | bp_diastolic | mmHg | mmHg | 25 – 180 |
| GLU | glucose | glucose | mg/dL | mg/dL | 20 – 700 |
| TEMP | temp | body_temp | °C | °C | 30 – 43 |
| SLEEP | sleep | sleep_hours | h | h | 0 – 24 |
| MOOD | mood | mood | /5 | score | 1 – 5 |
| EX_MIN | exercise_min | exercise_minutes | min | min | 0 – 1440 |
| RAD_CUM | rad_dose | radiation_dose_cumulative | mSv | mSv | 0 – 10000 |

- `spo2` موجود في الـ backend فقط؛ الفرونت إند لا يستخدمه.
- المزاج: `POST /api/measurements` يقبل `"unit": "/5"` ويخزّنه `score`. عند القراءة يحوّل الـ adapter الوحدة إلى `/5`.
- الوقت: الـ backend يخزّن `2026-10-15T07:30:00Z` (UTC، بلا أجزاء ثانية)، والفرونت إند يكتب `2026-10-15T07:30:00.000Z`. اللحظة نفسها.

### Row fields

| Frontend `RawRow` / `Reading` | Backend `measurements` (`GET /api/measurements?astronaut_id=1&limit=2000`) |
|---|---|
| `time_utc` / `timestamp` | `measured_at` |
| `metric` / `indicator` | `indicator_code` (الجدول أعلاه) |
| `value` | `value` (`null` = not available) |
| `unit` | `unit` |
| `source` | `source_name` |
| `provenance` | `source_type` |

### Status mapping

حالة المؤشرات الحيوية تُحسب في `frontend/src/lib/rules.ts` فقط. الـ backend لا يحسبها ولا تُنقل القواعد إلى Rust.
حالات الـ backend التالية تخص نموذج المقصورة وفحص العين، وتُحوَّل عند الـ adapter:

| Backend value | Where it appears | UI status |
|---|---|---|
| `ok` | `/api/eye/*` | `ok` |
| `typical` | `/api/environment/assess` | `ok` |
| `watch` | `/api/environment/assess`, `/api/eye/*` | `watch` |
| `attention` | `/api/environment/assess`, `/api/eye/*` | `act` |
| `"not available"` أو `null` أو HTTP 404 بـ `detail` | أي مكان | `nodata` |

| Backend `source_type` | UI `provenance` |
|---|---|
| `simulated` | `simulated` |
| `imported` | `imported` |
| `real` | `real` |
| `manual` | `real` (إدخال الرائد نفسه؛ الـ check-in يرسل `source_type: "real"`) |

| Backend `quality` | Meaning |
|---|---|
| `ok` | قراءة عادية |
| `suspect` | القيمة محفوظة ومعروضة لكن معلَّمة (مثلاً CO₂ أقل من 300 ppm، أو قياس بلا وحدة) |
| `missing` | لا قيمة: تُعرض "not available" |

`/api/alerts` و`/api/overview/{id}` يستخدمان قواعد `alert_rules` القديمة في الـ backend (`normal / info / review / urgent`).
هي لصفحات `/dev/` فقط، والفرونت إند لا يقرؤها.

## التمرين المُتحقَّق بالكاميرا (`src/exercise.rs`)

المتصفح يعدّ تكرارات السكوات بـ MediaPipe Pose ويرسل **ملخّص الجلسة فقط** (بدون فيديو):

```
POST /api/exercise/sessions
{"astronaut_id":1,"kind":"squat","started_at":"2026-11-14T08:00:00Z","duration_s":150,
 "reps":12,"reps_valid":10,"depth_deg_median":92.5,"symmetry_diff_deg_median":6.0,"source":"camera-verified"}
GET  /api/exercise/sessions?astronaut_id=1[&limit=100]
```

- الرد `201 {session, measurement, alerts}`. رائد فضاء غير موجود ⇒ `404`. مدخلات خاطئة ⇒ `422`. نفس الجلسة مرتين ⇒ `409`.
- التحقق حدود فيزيائية/منطقية فقط، **وليست حدوداً طبية**: `kind=squat`، `source=camera-verified`، الزوايا بين 0 و180، `reps_valid ≤ reps`، المدة بين 0 ويوم واحد، والجلسة لا تنتهي في المستقبل (سماحية 60 ثانية لفرق الساعات).
- `depth_deg_median` إلزامي إذا `reps_valid > 0`، و`symmetry_diff_deg_median` اختياري لأن الرجل البعيدة تختفي في الزاوية الجانبية. إذا `reps_valid = 0` يجب أن يكونا `null`.
- إذا كان فيه تكرار صحيح واحد على الأقل، تُضاف قراءة `exercise_min` (القيمة = `duration_s / 60`، `source_type="real"`، `source_name="camera-verified (MediaPipe pose, squat)"`) إلى جدول `measurements`، ثم يعمل `logic::evaluate_measurement`. بدون تكرار صحيح لا تُسجَّل دقائق.
- المؤشر `exercise_min` والجدول `exercise_sessions` يُنشآن داخل `exercise.rs` (`INSERT OR IGNORE` و`CREATE TABLE IF NOT EXISTS`) عند أول طلب، بنفس طريقة `eye.rs`. لذلك لا يظهر `exercise_min` في `/api/indicators` و`/api/overview` إلا بعد أول طلب تمرين.
- الاختبارات: `cargo test --test exercise`.

## Exercise — frontend part (pending UI)

Not built yet: the UI design is not final. This is the agreed plan, ready for when the frontend is unblocked.
All thresholds below are **DEMO · PENDING VALIDATION**: chosen for the demo, not taken from a clinical source.

**Where it lives:** `frontend/src/features/exercise/**`, plus a lazy route in `App.tsx`
(`const Exercise = lazy(() => import('./features/exercise/ExercisePage'))` and `<Route path="/exercise" … />`).

**Angles (`angles.ts`)**
- Knee angle per side = angle at the knee between hip and ankle, from MediaPipe Pose landmarks
  23/25/27 (left hip/knee/ankle) and 24/26/28 (right).
- Landmarks are normalised 0..1 on both axes, so x is multiplied by `videoWidth / videoHeight` before
  the angle is computed. Without this, angles are wrong on any non-square frame.
- Smoothing: median of the last 5 frames per side.
- Visibility gate: a side counts only if hip, knee and ankle all have `visibility ≥ 0.5`. If neither
  side passes: "Can't see your legs. Step back so your whole body is in view." and no counting.

**Reps (`reps.ts`)**
- State machine: standing → down when the angle drops below 140°; a rep is counted when it rises back above 160°.
  The gap between 140 and 160 (hysteresis) stops jitter around one value from counting twice.
- Per rep: depth = lowest knee angle, duration, left/right depth difference.
- One visible leg is enough to count. Symmetry needs both legs; otherwise it is "not available", never guessed
  (in a side view the far leg is hidden).
- Coach lines (one at a time): "Side view works best." / "Go a little deeper." / "Left and right are uneven."

**Personal baseline (`baseline.ts`)**
- The first 3 sessions (from `GET /api/exercise/sessions`) set "your usual" = median depth and median rep time.
- Later sessions are compared with that, never with a textbook value.

**Saving**
- `POST /api/exercise/sessions` (contract above).
- The dashboard reads readings from its zustand store, not from the backend. So the page also calls the
  existing store action `logCheckin([{ metric: 'exercise', values: [minutes], source: 'camera-verified' }])`.
  This adds an `exercise_min` reading and updates "Muscles & bones" with no change to `rules.ts` or the store.

**Result card:** How did I do? (reps, depth vs your usual) · Why? (which reps did not count and why) ·
What next? (one plain action).

**Details section (honest limits):** 2D webcam only; the angles change with camera height and position;
it does not diagnose injury, pain or dizziness; thresholds DEMO · PENDING VALIDATION.

**Tests:** synthetic landmark sequences: a full squat, a half squat, jitter around 160° (must count once),
a hidden leg, and uneven sides. Needs a test runner: `vitest` as a devDependency (not added yet; needs approval).

**Vendored MediaPipe assets** → `frontend/public/vendor/mediapipe/` (no CDN, no network at runtime)

| File | Source | Size (bytes) | sha256 | Licence |
|---|---|---|---|---|
| `wasm/vision_wasm_internal.js` | npm `@mediapipe/tasks-vision@1.2.3` (`wasm/`) | 336,624 | `2aa5fd3fdd3d8208cd7587df0bb19fb6925c4ea16a76dd025aedc1f64d6a6309` | Apache-2.0 (package.json) |
| `wasm/vision_wasm_internal.wasm` | same package | 14,665,716 | `225bc06c0f51a9cf31fea0e9e0b0243e9e01fb5ef332cc1a7fa6656dbdfdaabf` | Apache-2.0 (package.json) |
| `pose_landmarker_lite.task` | `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task` | 5,777,746 | `59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a` | **Not confirmed yet.** The Pose Landmarker docs page states no licence. Read the model card ("Model Card BlazePose GHUM 3D", `https://storage.googleapis.com/mediapipe-assets/Model%20Card%20BlazePose%20GHUM%203D.pdf`) before vendoring. |

- Why only these two wasm files: `FilesetResolver.forVisionTasks(base)` loads `${base}/vision_wasm_internal.{js,wasm}`
  (checked in `vision_bundle.mjs`). The `*_module_internal` files are only used with `useModule = true`.
- Why lite: it is the smallest (5.8 MB vs full 9.4 MB, heavy 30.7 MB), for weaker laptops.
- Download script (planned): copy the wasm from `node_modules/@mediapipe/tasks-vision/wasm` so it always matches
  the installed JS version, download the `.task`, and check the sha256 values above.
- API checked in `vision.d.ts` 1.2.3: `PoseLandmarker.createFromOptions`, `detectForVideo(video, timestampMs)`,
  `PoseLandmarker.POSE_CONNECTIONS`, `NormalizedLandmark.visibility`.

**Still open:** the model licence; whether the ~20.8 MB of assets is committed to git (works offline straight
from a clone) or downloaded by the script (needs a `.gitignore` entry); vitest approval.

## Local AI (Atlas)

- Once: `ollama create ai -f ai/Modelfile` (from `backend/`; registers Qwen2.5-0.5B under the name `ai`).
- `GET /api/ai/status` -> `{reachable, model_installed, model, hint?, ...}`.
- `POST /api/ai/chat {message, astronaut_id}` -> `{reply, model, elapsed_ms, disclaimer, ...}` (context = latest values + open alerts from the database).
- The model is small (0.5B) and can be wrong: it explains the data it is given, it does not diagnose. The numbers on screen stay the source of truth.
- When Ollama is off, `/api/ai/chat` answers 503 and the frontend falls back to Atlas's built-in rules.
