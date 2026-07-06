export const MED_PLAIN: Record<string, { why: string; instructions: string; hasVideo: boolean }> = {
  "Metformin":             { why: "Controls blood sugar for diabetes",                      instructions: "Take with food or right after eating — prevents stomach upset.",               hasVideo: false },
  "Amlodipine":            { why: "Lowers blood pressure to protect your heart",            instructions: "Take at the same time each day, with or without food.",                        hasVideo: false },
  "Celecoxib":             { why: "Relieves pain and stiffness in your joints",             instructions: "Take with food to protect your stomach. Do not exceed the prescribed dose.",   hasVideo: false },
  "Atorvastatin":          { why: "Reduces cholesterol to lower heart disease risk",        instructions: "Take at night before bed. Avoid grapefruit and grapefruit juice.",             hasVideo: false },
  "Warfarin":              { why: "Prevents blood clots — vital for your heart condition",  instructions: "Take at the same time every day. Keep your diet consistent, especially green vegetables.", hasVideo: false },
  "Bisoprolol":            { why: "Keeps your heart beating steadily and gently",           instructions: "Take in the morning. Never stop suddenly without checking with your doctor.",  hasVideo: false },
  "Latanoprost Eye Drops": { why: "Reduces eye pressure to protect your vision",            instructions: "One drop in each eye at bedtime. Tilt head back, look up, squeeze gently.",   hasVideo: true  },
};

export const ESTATUS = {
  taken:    { bg: "bg-emerald-50", text: "text-emerald-700", border: "border-emerald-200", label: "✓ Taken",  dot: "bg-emerald-500" },
  missed:   { bg: "bg-red-50",     text: "text-red-700",     border: "border-red-200",     label: "⚠ Missed", dot: "bg-red-400"     },
  upcoming: { bg: "bg-sky-50",     text: "text-sky-700",     border: "border-sky-200",     label: "Due soon", dot: "bg-sky-400"     },
  skipped:  { bg: "bg-stone-50",   text: "text-stone-500",   border: "border-stone-200",   label: "Skipped",  dot: "bg-stone-300"   },
} as const;

export const MED_REASONS: Record<string, string> = {
  "Diabetes":       "It helps your body control blood sugar levels. Best taken with food.",
  "Blood Pressure": "It lowers your blood pressure to protect your heart and kidneys.",
  "Cholesterol":    "It reduces bad cholesterol in your blood to lower heart disease risk.",
  "Joint Pain":     "It eases pain and stiffness in your joints so you move more comfortably.",
  "Blood Thinning": "It prevents dangerous blood clots from forming in your blood vessels.",
  "Heart Rate":     "It keeps your heart beating at a steady, gentle pace.",
  "Glaucoma":       "These drops reduce pressure in your eye to protect your eyesight.",
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

export const EYEDROP_STEPS = [
  { icon: "🧼", text: "Wash your hands thoroughly with soap and water" },
  { icon: "🪞", text: "Tilt your head back and look up at the ceiling" },
  { icon: "👁️", text: "Gently pull down your lower eyelid to form a small pocket" },
  { icon: "💧", text: "Hold the bottle above your eye and squeeze 1 drop into the pocket" },
  { icon: "😌", text: "Close your eye gently — do not blink or rub" },
  { icon: "🔁", text: "Press the inner corner of your eye for 1 minute to help absorb" },
  { icon: "✅", text: "Repeat for the other eye. Use nightly before bed" },
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

export const PRESET_TIMES = ["6:00 AM", "7:00 AM", "8:00 AM", "12:00 PM", "2:00 PM", "6:00 PM", "8:00 PM", "9:00 PM", "10:00 PM"];

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

export const VOICE_DEMOS = [
  "I took my morning medicine",
  "What medicines do I have today?",
  "Am I running low on anything?",
  "What is metformin for?",
  "Show me my prescription list",
];

// Common conditions offered as type-ahead suggestions for the "Purpose" field.
export const COMMON_CONDITIONS = [
  "Diabetes", "Blood Pressure", "Cholesterol", "Joint Pain", "Blood Thinning",
  "Heart Rate", "Glaucoma", "Acid Reflux", "Asthma", "Thyroid", "Osteoporosis",
  "Pain Relief", "Allergy", "Anxiety", "Fluid Retention", "Vitamins",
];

// Catalogue of common medications for the type-ahead. Picking one auto-fills the
// usual purpose and a typical dose, which the user can still edit.
export const MEDICATION_CATALOG: { name: string; purpose: string; dose: string }[] = [
  { name: "Metformin",             purpose: "Diabetes",        dose: "500mg" },
  { name: "Gliclazide",            purpose: "Diabetes",        dose: "80mg" },
  { name: "Insulin",               purpose: "Diabetes",        dose: "per sliding scale" },
  { name: "Amlodipine",            purpose: "Blood Pressure",  dose: "5mg" },
  { name: "Losartan",              purpose: "Blood Pressure",  dose: "50mg" },
  { name: "Ramipril",              purpose: "Blood Pressure",  dose: "5mg" },
  { name: "Atorvastatin",          purpose: "Cholesterol",     dose: "20mg" },
  { name: "Simvastatin",           purpose: "Cholesterol",     dose: "20mg" },
  { name: "Celecoxib",             purpose: "Joint Pain",      dose: "200mg" },
  { name: "Paracetamol",           purpose: "Pain Relief",     dose: "500mg" },
  { name: "Warfarin",              purpose: "Blood Thinning",  dose: "3mg" },
  { name: "Aspirin",               purpose: "Blood Thinning",  dose: "100mg" },
  { name: "Bisoprolol",            purpose: "Heart Rate",      dose: "2.5mg" },
  { name: "Metoprolol",            purpose: "Heart Rate",      dose: "50mg" },
  { name: "Latanoprost Eye Drops", purpose: "Glaucoma",        dose: "1 drop each eye" },
  { name: "Omeprazole",            purpose: "Acid Reflux",     dose: "20mg" },
  { name: "Salbutamol Inhaler",    purpose: "Asthma",          dose: "2 puffs" },
  { name: "Levothyroxine",         purpose: "Thyroid",         dose: "50mcg" },
  { name: "Furosemide",            purpose: "Fluid Retention", dose: "40mg" },
  { name: "Calcium + Vitamin D",   purpose: "Osteoporosis",    dose: "1 tablet" },
];
