// `whyKey` rather than a literal: this line is the plain-language REASON a
// person takes the medicine (not its dosing instructions, which stay English by
// policy — see language.ts::localizeMedText), and it is rendered on the elder's
// prescription card. Holding it as English prose here made the localized
// fallback beside it unreachable for all seven seeded medicines.
export const MED_PLAIN: Record<string, { whyKey: string; instructions: string; hasVideo: boolean }> = {
  "Metformin":             { whyKey: "prescription.why.metformin",             instructions: "Take with food or right after eating — prevents stomach upset.",               hasVideo: false },
  "Amlodipine":            { whyKey: "prescription.why.amlodipine",            instructions: "Take at the same time each day, with or without food.",                        hasVideo: false },
  "Celecoxib":             { whyKey: "prescription.why.celecoxib",             instructions: "Take with food to protect your stomach. Do not exceed the prescribed dose.",   hasVideo: false },
  "Atorvastatin":          { whyKey: "prescription.why.atorvastatin",          instructions: "Take at night before bed. Avoid grapefruit and grapefruit juice.",             hasVideo: false },
  "Warfarin":              { whyKey: "prescription.why.warfarin",              instructions: "Take at the same time every day. Keep your diet consistent, especially green vegetables.", hasVideo: false },
  "Bisoprolol":            { whyKey: "prescription.why.bisoprolol",            instructions: "Take in the morning. Never stop suddenly without checking with your doctor.",  hasVideo: false },
  "Latanoprost Eye Drops": { whyKey: "prescription.why.latanoprostEyeDrops",   instructions: "One drop in each eye at bedtime. Tilt head back, look up, squeeze gently.",   hasVideo: true  },
};

export const MED_SIMPLE: Record<string, string> = {
  "Metformin":             "Take 1 tablet after meal",
  "Amlodipine":            "Take 1 tablet after meal",
  "Celecoxib":             "Take 1 capsule after meal",
  "Atorvastatin":          "Take 1 tablet before sleeping",
  "Warfarin":              "Take 1 tablet after dinner",
  "Bisoprolol":            "Take 1 tablet after breakfast",
  "Latanoprost Eye Drops": "1 drop in each eye before sleeping",
};

// A step-by-step "how to put the drops in" panel an elder reads while doing it,
// so the text is keyed like the rest of the app's copy rather than held as
// English here. The emoji is a status anchor and stays as-is in every language.
export const EYEDROP_STEPS: { icon: string; textKey: string }[] = [
  { icon: "🧼", textKey: "eyedrop.step1" },
  { icon: "🪞", textKey: "eyedrop.step2" },
  { icon: "👁️", textKey: "eyedrop.step3" },
  { icon: "💧", textKey: "eyedrop.step4" },
  { icon: "😌", textKey: "eyedrop.step5" },
  { icon: "🔁", textKey: "eyedrop.step6" },
  { icon: "✅", textKey: "eyedrop.step7" },
];

export const MED_PHOTOS: Record<string, string> = {
  "Metformin":             "https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=120&h=120&fit=crop&auto=format",
  "Amlodipine":            "https://images.unsplash.com/photo-1588718889344-f7bd7a565d20?w=120&h=120&fit=crop&auto=format",
  "Celecoxib":             "https://images.unsplash.com/photo-1587854692152-cbe660dbde88?w=120&h=120&fit=crop&auto=format",
  "Atorvastatin":          "https://images.unsplash.com/photo-1550572017-26b5655c1e8c?w=120&h=120&fit=crop&auto=format",
  "Warfarin":              "https://images.unsplash.com/photo-1573883429746-084be9b5cfca?w=120&h=120&fit=crop&auto=format",
  "Bisoprolol":            "https://images.unsplash.com/photo-1522335579687-9c718c5184d7?w=120&h=120&fit=crop&auto=format",
  "Latanoprost Eye Drops": "https://images.unsplash.com/photo-1750125625145-7be950011e4c?w=120&h=120&fit=crop&auto=format",
};

// Generic medicine photography for anything not in MED_PHOTOS above, picked
// deterministically by name so a given medicine always shows the same image.
// These are ILLUSTRATIVE stock photos, not the real pill for that drug — the
// same is already true of MED_PHOTOS. The accurate physical identifier is the
// shape/marking text in MED_SHAPES, which colour-vision mode surfaces.
export const MED_PHOTO_FALLBACKS: string[] = [
  "https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=160&h=160&fit=crop&auto=format",
  "https://images.unsplash.com/photo-1471864190281-a93a3070b6de?w=160&h=160&fit=crop&auto=format",
  "https://images.unsplash.com/photo-1587854692152-cbe660dbde88?w=160&h=160&fit=crop&auto=format",
  "https://images.unsplash.com/photo-1550572017-26b5655c1e8c?w=160&h=160&fit=crop&auto=format",
  "https://images.unsplash.com/photo-1512069772995-ec65ed45afd6?w=160&h=160&fit=crop&auto=format",
  "https://images.unsplash.com/photo-1585435557343-3b092031a831?w=160&h=160&fit=crop&auto=format",
  "https://images.unsplash.com/photo-1607619056574-7b8d3ee536b2?w=160&h=160&fit=crop&auto=format",
  "https://images.unsplash.com/photo-1522335579687-9c718c5184d7?w=160&h=160&fit=crop&auto=format",
];

export const MED_FREQUENCY: Record<string, string> = {
  "Celecoxib": "Every other day",
};

export const MED_SHAPES: Record<string, { shape: string; marking: string }> = {
  "Metformin":             { shape: "Round tablet",                                         marking: "Scored line down the middle" },
  "Amlodipine":            { shape: "Oval tablet",                                           marking: "Stamped with a dosage number" },
  "Celecoxib":             { shape: "Two-piece capsule, longer than the tablets",             marking: "Brand name printed along its length" },
  "Atorvastatin":          { shape: "Oval tablet, film-coated with a smooth, glossy surface", marking: "No score line — smooth on both sides" },
  "Warfarin":              { shape: "Small round tablet, smaller than the Metformin tablet",  marking: "Cross-scored on one side" },
  "Bisoprolol":            { shape: "Round, film-coated tablet",                              marking: "Heart shape embossed on one side" },
  "Latanoprost Eye Drops": { shape: "Small dropper bottle with a narrow neck",                 marking: "Ridged grip on the cap for easy handling" },
};

export const MED_COLOURS = [
  { hex: "#0D5C8A", label: "Blue" },
  { hex: "#2E7D32", label: "Green" },
  { hex: "#7B3F9E", label: "Purple" },
  { hex: "#C05621", label: "Orange" },
  { hex: "#B91C1C", label: "Red" },
  { hex: "#0E7490", label: "Teal" },
];


// Fallback clock times for vague / meal-relative doses (e.g. "after breakfast").
// In a real deployment these come from the caregiver's saved routine for the
// elder; here we default to Singapore national-average meal/wake times. Keys are
// matched longest-first against the dose's time text and its plain-language
// direction, so "after breakfast" wins over "breakfast".
export const MEAL_TIMES: Record<string, string> = {
  "after breakfast": "8:30 AM",
  "before breakfast": "7:00 AM",
  "after lunch":      "1:00 PM",
  "before lunch":     "12:00 PM",
  "after dinner":     "7:30 PM",
  "before dinner":    "6:00 PM",
  "before bed":       "10:00 PM",
  "before sleep":     "10:00 PM",
  "bedtime":          "10:00 PM",
  "breakfast":        "8:00 AM",
  "lunch":            "12:30 PM",
  "dinner":           "7:00 PM",
  "morning":          "8:00 AM",
  "afternoon":        "2:00 PM",
  "evening":          "7:00 PM",
  "night":            "10:00 PM",
  "noon":             "12:00 PM",
};

// Common conditions offered as type-ahead suggestions for the "Purpose" field.
// `value` is the canonical English string that actually gets stored (never
// machine-translated, matching the app's policy for stored patient data);
// `labelKey` is only used to localize what's *displayed* in the suggestion list.
export const COMMON_CONDITIONS: { value: string; labelKey: string }[] = [
  { value: "Diabetes", labelKey: "catalog.condition.diabetes" },
  { value: "Blood Pressure", labelKey: "catalog.condition.bloodPressure" },
  { value: "Cholesterol", labelKey: "catalog.condition.cholesterol" },
  { value: "Joint Pain", labelKey: "catalog.condition.jointPain" },
  { value: "Blood Thinning", labelKey: "catalog.condition.bloodThinning" },
  { value: "Heart Rate", labelKey: "catalog.condition.heartRate" },
  { value: "Glaucoma", labelKey: "catalog.condition.glaucoma" },
  { value: "Acid Reflux", labelKey: "catalog.condition.acidReflux" },
  { value: "Asthma", labelKey: "catalog.condition.asthma" },
  { value: "Thyroid", labelKey: "catalog.condition.thyroid" },
  { value: "Osteoporosis", labelKey: "catalog.condition.osteoporosis" },
  { value: "Pain Relief", labelKey: "catalog.condition.painRelief" },
  { value: "Allergy", labelKey: "catalog.condition.allergy" },
  { value: "Anxiety", labelKey: "catalog.condition.anxiety" },
  { value: "Fluid Retention", labelKey: "catalog.condition.fluidRetention" },
  { value: "Vitamins", labelKey: "catalog.condition.vitamins" },
  { value: "Atrial Fibrillation", labelKey: "catalog.condition.atrialFibrillation" },
  { value: "Chronic Kidney Disease", labelKey: "catalog.condition.chronicKidneyDisease" },
];

// Starter list for the allergy type-ahead — not a real medical database, just
// enough common entries to make autofill useful today. Free text is still
// allowed for anything not on this list.
export const COMMON_ALLERGIES: { value: string; labelKey: string }[] = [
  { value: "Peanuts", labelKey: "catalog.allergy.peanuts" },
  { value: "Tree nuts", labelKey: "catalog.allergy.treeNuts" },
  { value: "Shellfish", labelKey: "catalog.allergy.shellfish" },
  { value: "Fish", labelKey: "catalog.allergy.fish" },
  { value: "Eggs", labelKey: "catalog.allergy.eggs" },
  { value: "Milk", labelKey: "catalog.allergy.milk" },
  { value: "Soy", labelKey: "catalog.allergy.soy" },
  { value: "Wheat / Gluten", labelKey: "catalog.allergy.wheatGluten" },
  { value: "Sesame", labelKey: "catalog.allergy.sesame" },
  { value: "Latex", labelKey: "catalog.allergy.latex" },
  { value: "Pollen", labelKey: "catalog.allergy.pollen" },
  { value: "Dust mites", labelKey: "catalog.allergy.dustMites" },
  { value: "Pet dander", labelKey: "catalog.allergy.petDander" },
  { value: "Bee stings", labelKey: "catalog.allergy.beeStings" },
  { value: "Mould", labelKey: "catalog.allergy.mould" },
];

// Starter list for the medicine-allergy type-ahead — common drugs/drug classes
// people report reactions to.
export const COMMON_DRUG_ALLERGIES: { value: string; labelKey: string }[] = [
  { value: "Penicillin", labelKey: "catalog.drugAllergy.penicillin" },
  { value: "Sulfa drugs", labelKey: "catalog.drugAllergy.sulfaDrugs" },
  { value: "Aspirin", labelKey: "catalog.drugAllergy.aspirin" },
  { value: "Ibuprofen", labelKey: "catalog.drugAllergy.ibuprofen" },
  { value: "Codeine", labelKey: "catalog.drugAllergy.codeine" },
  { value: "Morphine", labelKey: "catalog.drugAllergy.morphine" },
  { value: "Iodine contrast dye", labelKey: "catalog.drugAllergy.iodineContrastDye" },
  { value: "Local anaesthetics", labelKey: "catalog.drugAllergy.localAnaesthetics" },
  { value: "Certain antibiotics", labelKey: "catalog.drugAllergy.certainAntibiotics" },
];

// The other half of the store-English/display-localized policy above. Until
// now only the type-ahead DROPDOWNS were localized (via withCatalogLabels) —
// every screen that renders an ALREADY-SAVED condition, allergy or medication
// purpose printed the raw canonical English `value`, so switching the app's
// language left all of that vocabulary in English.
//
// Lookup is by canonical value or one of its listed synonyms (CATALOG_ALIASES
// below), normalised for case/spacing/trailing-bracket qualifiers, and MISSES
// FALL BACK to the raw string — deliberately: conditions[] is a mixed bag of
// catalog values, free text the person typed, and whatever Hermes's OCR
// extracted from a report, and arbitrary text obviously cannot be translated.
//
// One map covers conditions, allergies, drug allergies AND medication purposes,
// because MEDICATION_CATALOG.purposeKey draws on the same catalog.condition.*
// vocabulary as COMMON_CONDITIONS.

// Everyday and clinical synonyms for the catalog values above, so a profile that
// stores what a discharge summary / a doctor / an OCR extraction actually said
// ("Type 2 Diabetes", "Hypertension", "Osteoarthritis") still renders in the
// person's language. Left-hand side is the synonym; right-hand side MUST be a
// canonical `value` from one of the three lists above — a typo resolves to
// nothing rather than to the wrong condition.
//
// This is a fixed synonym table, NOT a fuzzy matcher: nothing here guesses. A
// term that isn't listed falls through to the raw string exactly as before.
const CATALOG_ALIASES: Record<string, string> = {
  // Conditions
  "Type 2 Diabetes": "Diabetes",
  "Type 1 Diabetes": "Diabetes",
  "Diabetes Mellitus": "Diabetes",
  "T2DM": "Diabetes",
  "T1DM": "Diabetes",
  "High Blood Sugar": "Diabetes",
  "Hyperglycaemia": "Diabetes",
  "Hyperglycemia": "Diabetes",
  "Hypertension": "Blood Pressure",
  "High Blood Pressure": "Blood Pressure",
  "Raised Blood Pressure": "Blood Pressure",
  "Essential Hypertension": "Blood Pressure",
  "HTN": "Blood Pressure",
  "High BP": "Blood Pressure",
  "High Cholesterol": "Cholesterol",
  "Hyperlipidaemia": "Cholesterol",
  "Hyperlipidemia": "Cholesterol",
  "Dyslipidaemia": "Cholesterol",
  "Dyslipidemia": "Cholesterol",
  "Hypercholesterolaemia": "Cholesterol",
  "Hypercholesterolemia": "Cholesterol",
  "High Lipids": "Cholesterol",
  "Osteoarthritis": "Joint Pain",
  "Arthritis": "Joint Pain",
  "Rheumatoid Arthritis": "Joint Pain",
  "Degenerative Joint Disease": "Joint Pain",
  "Knee Pain": "Joint Pain",
  "Joint Inflammation": "Joint Pain",
  "Anticoagulation": "Blood Thinning",
  "Blood Thinner": "Blood Thinning",
  "Blood Thinners": "Blood Thinning",
  "Blood Clots": "Blood Thinning",
  "Clot Prevention": "Blood Thinning",
  "Stroke Prevention": "Blood Thinning",
  "Deep Vein Thrombosis": "Blood Thinning",
  "DVT": "Blood Thinning",
  "Heart Rhythm": "Heart Rate",
  "Palpitations": "Heart Rate",
  "Rapid Heartbeat": "Heart Rate",
  "Tachycardia": "Heart Rate",
  "Eye Pressure": "Glaucoma",
  "High Eye Pressure": "Glaucoma",
  "Ocular Hypertension": "Glaucoma",
  "Open-angle Glaucoma": "Glaucoma",
  "GERD": "Acid Reflux",
  "GORD": "Acid Reflux",
  "Reflux": "Acid Reflux",
  "Heartburn": "Acid Reflux",
  "Gastritis": "Acid Reflux",
  "Gastric": "Acid Reflux",
  "Stomach Acid": "Acid Reflux",
  "Bronchial Asthma": "Asthma",
  "Wheezing": "Asthma",
  "Hypothyroidism": "Thyroid",
  "Hyperthyroidism": "Thyroid",
  "Underactive Thyroid": "Thyroid",
  "Overactive Thyroid": "Thyroid",
  "Thyroid Disease": "Thyroid",
  "Goitre": "Thyroid",
  "Goiter": "Thyroid",
  "Osteopenia": "Osteoporosis",
  "Bone Density": "Osteoporosis",
  "Weak Bones": "Osteoporosis",
  "Bone Health": "Osteoporosis",
  "Pain": "Pain Relief",
  "Chronic Pain": "Pain Relief",
  "Painkiller": "Pain Relief",
  "Analgesia": "Pain Relief",
  "Back Pain": "Pain Relief",
  "Headache": "Pain Relief",
  "Allergies": "Allergy",
  "Allergic Rhinitis": "Allergy",
  "Hay Fever": "Allergy",
  "Anxiety Disorder": "Anxiety",
  "Generalised Anxiety Disorder": "Anxiety",
  "Generalized Anxiety Disorder": "Anxiety",
  "Panic Attacks": "Anxiety",
  "Oedema": "Fluid Retention",
  "Edema": "Fluid Retention",
  "Water Retention": "Fluid Retention",
  "Fluid Overload": "Fluid Retention",
  "Swollen Legs": "Fluid Retention",
  "Vitamin Supplement": "Vitamins",
  "Vitamin Supplements": "Vitamins",
  "Supplements": "Vitamins",
  "Multivitamin": "Vitamins",
  "Vitamin Deficiency": "Vitamins",
  "Vitamin D Deficiency": "Vitamins",
  "AF": "Atrial Fibrillation",
  "AFib": "Atrial Fibrillation",
  "A-Fib": "Atrial Fibrillation",
  "Irregular Heartbeat": "Atrial Fibrillation",
  "Irregular Heart Rhythm": "Atrial Fibrillation",
  "CKD": "Chronic Kidney Disease",
  "Kidney Disease": "Chronic Kidney Disease",
  "Chronic Renal Failure": "Chronic Kidney Disease",
  "Chronic Kidney Failure": "Chronic Kidney Disease",
  "Renal Impairment": "Chronic Kidney Disease",
  "Renal Failure": "Chronic Kidney Disease",
  "Kidney Failure": "Chronic Kidney Disease",
  // Allergies
  "Peanut": "Peanuts",
  "Groundnut": "Peanuts",
  "Groundnuts": "Peanuts",
  "Tree nut": "Tree nuts",
  "Nuts": "Tree nuts",
  "Almonds": "Tree nuts",
  "Cashews": "Tree nuts",
  "Walnuts": "Tree nuts",
  "Hazelnuts": "Tree nuts",
  "Seafood": "Shellfish",
  "Prawns": "Shellfish",
  "Shrimp": "Shellfish",
  "Crab": "Shellfish",
  "Lobster": "Shellfish",
  "Crustaceans": "Shellfish",
  "Finfish": "Fish",
  "Egg": "Eggs",
  "Egg White": "Eggs",
  "Chicken Egg": "Eggs",
  "Dairy": "Milk",
  "Cow's Milk": "Milk",
  "Lactose": "Milk",
  "Milk Protein": "Milk",
  "Soya": "Soy",
  "Soybean": "Soy",
  "Soybeans": "Soy",
  "Soya Beans": "Soy",
  "Wheat": "Wheat / Gluten",
  "Gluten": "Wheat / Gluten",
  "Wheat/Gluten": "Wheat / Gluten",
  "Sesame Seeds": "Sesame",
  "Sesame Oil": "Sesame",
  "Rubber Latex": "Latex",
  "Natural Rubber Latex": "Latex",
  "Grass Pollen": "Pollen",
  "Tree Pollen": "Pollen",
  "Dust": "Dust mites",
  "House Dust": "Dust mites",
  "Dust Mite": "Dust mites",
  "House Dust Mites": "Dust mites",
  "Cats": "Pet dander",
  "Dogs": "Pet dander",
  "Cat Fur": "Pet dander",
  "Dog Fur": "Pet dander",
  "Pet Fur": "Pet dander",
  "Animal Dander": "Pet dander",
  "Bees": "Bee stings",
  "Bee Sting": "Bee stings",
  "Bee Venom": "Bee stings",
  "Wasp Stings": "Bee stings",
  "Insect Stings": "Bee stings",
  "Mold": "Mould",
  "Mildew": "Mould",
  "Fungal Spores": "Mould",
  // Medicine allergies
  "Penicillins": "Penicillin",
  "Penicillin G": "Penicillin",
  "Penicillin V": "Penicillin",
  "Amoxicillin": "Penicillin",
  "Amoxycillin": "Penicillin",
  "Augmentin": "Penicillin",
  "Beta-lactams": "Penicillin",
  "Sulfa": "Sulfa drugs",
  "Sulpha drugs": "Sulfa drugs",
  "Sulfonamides": "Sulfa drugs",
  "Sulphonamides": "Sulfa drugs",
  "Co-trimoxazole": "Sulfa drugs",
  "Bactrim": "Sulfa drugs",
  "ASA": "Aspirin",
  "Acetylsalicylic Acid": "Aspirin",
  "Salicylates": "Aspirin",
  "NSAID": "Ibuprofen",
  "NSAIDs": "Ibuprofen",
  "Brufen": "Ibuprofen",
  "Nurofen": "Ibuprofen",
  "Naproxen": "Ibuprofen",
  "Diclofenac": "Ibuprofen",
  "Codeine Phosphate": "Codeine",
  "Dihydrocodeine": "Codeine",
  "Opioids": "Morphine",
  "Opiates": "Morphine",
  "Oxycodone": "Morphine",
  "Fentanyl": "Morphine",
  "Pethidine": "Morphine",
  "Tramadol": "Morphine",
  "Iodine contrast": "Iodine contrast dye",
  "Contrast dye": "Iodine contrast dye",
  "Contrast media": "Iodine contrast dye",
  "IV contrast": "Iodine contrast dye",
  "Radiocontrast": "Iodine contrast dye",
  "Iodine": "Iodine contrast dye",
  "Local anesthetics": "Local anaesthetics",
  "Lignocaine": "Local anaesthetics",
  "Lidocaine": "Local anaesthetics",
  "Xylocaine": "Local anaesthetics",
  "Novocaine": "Local anaesthetics",
  "Antibiotics": "Certain antibiotics",
  "Cephalosporins": "Certain antibiotics",
  "Erythromycin": "Certain antibiotics",
  "Tetracycline": "Certain antibiotics",
  "Ciprofloxacin": "Certain antibiotics",
  "Clindamycin": "Certain antibiotics",
  "Vancomycin": "Certain antibiotics",
  "Metronidazole": "Certain antibiotics",
};

// Lookup key for a stored value: case- and spacing-insensitive, and blind to a
// trailing qualifier in brackets so "Chronic Kidney Disease (Stage 3)" resolves
// like "Chronic Kidney Disease". Deliberately conservative — it normalises
// FORMATTING, it does not try to interpret wording.
function catalogKeyOf(value: string): string {
  return value
    .replace(/\s*\([^()]*\)\s*$/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

const CATALOG_LABEL_KEYS: Map<string, string> = (() => {
  const map = new Map<string, string>();
  const add = (value: string, labelKey: string) => {
    const key = catalogKeyOf(value);
    if (key && !map.has(key)) map.set(key, labelKey);
  };
  for (const c of COMMON_CONDITIONS) add(c.value, c.labelKey);
  for (const a of COMMON_ALLERGIES) add(a.value, a.labelKey);
  for (const d of COMMON_DRUG_ALLERGIES) add(d.value, d.labelKey);
  // AFTER the canonical values, never before: `add` is first-wins, so a synonym
  // that happens to collide with a real catalog entry can never displace it.
  for (const [alias, canonical] of Object.entries(CATALOG_ALIASES)) {
    const labelKey = map.get(catalogKeyOf(canonical));
    if (labelKey) add(alias, labelKey);
  }
  return map;
})();

// The canonical ENGLISH label behind each key, so localizeCatalogValue can tell
// "this language really has a translation" from "this IS the English label".
const CANONICAL_BY_KEY: Map<string, string> = (() => {
  const map = new Map<string, string>();
  for (const c of [...COMMON_CONDITIONS, ...COMMON_ALLERGIES, ...COMMON_DRUG_ALLERGIES]) {
    if (!map.has(c.labelKey)) map.set(c.labelKey, c.value);
  }
  return map;
})();

/**
 * The i18n key for a stored catalog value, or null when it isn't one of ours.
 * Prefer `localizeCatalogValue` — this exists for callers that need to know
 * whether a value is in the catalog at all.
 */
export function catalogLabelKey(value: string): string | null {
  return CATALOG_LABEL_KEYS.get(catalogKeyOf(value)) ?? null;
}

/**
 * Render a stored condition / allergy / purpose in the app's language, falling
 * back to the value itself for anything the person typed freehand.
 *
 * Pass `t` and the language in rather than importing them here: this module is
 * plain data and several of its consumers are, too.
 */
export function localizeCatalogValue(
  value: string,
  translate: (key: string) => string,
): string {
  const key = catalogLabelKey(value);
  if (!key) return value;
  const translated = translate(key);
  // t() returns the key itself when a language is missing an entry — never show
  // "catalog.condition.diabetes" to a person.
  if (translated === key) return value;
  // AN ALIAS IS INERT IN ENGLISH. A synonym exists only to REACH a translation:
  // "High blood pressure" resolves to catalog.condition.bloodPressure so a
  // Tamil reader sees Tamil. In English that same lookup resolves to the
  // canonical label "Blood Pressure" — i.e. the app would quietly rewrite the
  // words the person actually typed into the catalog's preferred phrasing.
  // There is nothing to gain from that (English is English either way) and a
  // real cost: someone who entered "High blood pressure" sees something they
  // did not write. So when the translation IS the canonical English label and
  // the stored value merely aliases to it, keep the stored value.
  const canonical = CANONICAL_BY_KEY.get(key);
  if (canonical && translated === canonical && catalogKeyOf(value) !== catalogKeyOf(canonical)) {
    return value;
  }
  return translated;
}

// Catalogue of common medications for the type-ahead. Picking one auto-fills the
// usual purpose and a typical dose, which the user can still edit. `purpose` is
// the canonical English value that gets stored; `purposeKey` (drawn from the
// same catalog.condition.* vocabulary as COMMON_CONDITIONS) only localizes the
// suggestion-list display. `dose` strings are left untranslated — locale-invariant
// (e.g. "500mg") or too safety-sensitive to machine-translate.
export const MEDICATION_CATALOG: { name: string; purpose: string; purposeKey: string; dose: string }[] = [
  { name: "Metformin",             purpose: "Diabetes",        purposeKey: "catalog.condition.diabetes",        dose: "500mg" },
  { name: "Gliclazide",            purpose: "Diabetes",        purposeKey: "catalog.condition.diabetes",        dose: "80mg" },
  { name: "Insulin",               purpose: "Diabetes",        purposeKey: "catalog.condition.diabetes",        dose: "per sliding scale" },
  { name: "Amlodipine",            purpose: "Blood Pressure",  purposeKey: "catalog.condition.bloodPressure",   dose: "5mg" },
  { name: "Losartan",              purpose: "Blood Pressure",  purposeKey: "catalog.condition.bloodPressure",   dose: "50mg" },
  { name: "Ramipril",              purpose: "Blood Pressure",  purposeKey: "catalog.condition.bloodPressure",   dose: "5mg" },
  { name: "Atorvastatin",          purpose: "Cholesterol",     purposeKey: "catalog.condition.cholesterol",     dose: "20mg" },
  { name: "Simvastatin",           purpose: "Cholesterol",     purposeKey: "catalog.condition.cholesterol",     dose: "20mg" },
  { name: "Celecoxib",             purpose: "Joint Pain",      purposeKey: "catalog.condition.jointPain",       dose: "200mg" },
  { name: "Paracetamol",           purpose: "Pain Relief",     purposeKey: "catalog.condition.painRelief",      dose: "500mg" },
  { name: "Warfarin",              purpose: "Blood Thinning",  purposeKey: "catalog.condition.bloodThinning",   dose: "3mg" },
  { name: "Aspirin",               purpose: "Blood Thinning",  purposeKey: "catalog.condition.bloodThinning",   dose: "100mg" },
  { name: "Bisoprolol",            purpose: "Heart Rate",      purposeKey: "catalog.condition.heartRate",       dose: "2.5mg" },
  { name: "Metoprolol",            purpose: "Heart Rate",      purposeKey: "catalog.condition.heartRate",       dose: "50mg" },
  { name: "Latanoprost Eye Drops", purpose: "Glaucoma",        purposeKey: "catalog.condition.glaucoma",        dose: "1 drop each eye" },
  { name: "Omeprazole",            purpose: "Acid Reflux",     purposeKey: "catalog.condition.acidReflux",      dose: "20mg" },
  { name: "Salbutamol Inhaler",    purpose: "Asthma",          purposeKey: "catalog.condition.asthma",          dose: "2 puffs" },
  { name: "Levothyroxine",         purpose: "Thyroid",         purposeKey: "catalog.condition.thyroid",         dose: "50mcg" },
  { name: "Furosemide",            purpose: "Fluid Retention", purposeKey: "catalog.condition.fluidRetention",  dose: "40mg" },
  { name: "Calcium + Vitamin D",   purpose: "Osteoporosis",    purposeKey: "catalog.condition.osteoporosis",    dose: "1 tablet" },
];
