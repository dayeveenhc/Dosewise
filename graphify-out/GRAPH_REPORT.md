# Graph Report - .  (2026-07-06)

## Corpus Check
- 130 files · ~73,845 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1203 nodes · 2371 edges · 70 communities (59 shown, 11 thin omitted)
- Extraction: 89% EXTRACTED · 11% INFERRED · 0% AMBIGUOUS · INFERRED: 255 edges (avg confidence: 0.8)
- Token cost: 89,300 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Agent Turn Loop|Agent Turn Loop]]
- [[_COMMUNITY_Session State & Fake DB (tests)|Session State & Fake DB (tests)]]
- [[_COMMUNITY_UI Kit AvatarBreadcrumb|UI Kit: Avatar/Breadcrumb]]
- [[_COMMUNITY_Web Frontend Dependencies|Web Frontend Dependencies]]
- [[_COMMUNITY_Reminder Scheduler (cron)|Reminder Scheduler (cron)]]
- [[_COMMUNITY_Web Frontend Provenance (Figmashadcn)|Web Frontend Provenance (Figma/shadcn)]]
- [[_COMMUNITY_UI Kit InputSeparatorSheet|UI Kit: Input/Separator/Sheet]]
- [[_COMMUNITY_App Settings & LLM Config|App Settings & LLM Config]]
- [[_COMMUNITY_Dosewise Architecture & Deployment|Dosewise Architecture & Deployment]]
- [[_COMMUNITY_Agent Loop Internals (dispatchdialect)|Agent Loop Internals (dispatch/dialect)]]
- [[_COMMUNITY_Tool Handler Framework|Tool Handler Framework]]
- [[_COMMUNITY_UI Kit BadgeCheckboxOTP|UI Kit: Badge/Checkbox/OTP]]
- [[_COMMUNITY_OpenFDA Drug Info Lookup|OpenFDA Drug Info Lookup]]
- [[_COMMUNITY_UI Kit Alert Dialog|UI Kit: Alert Dialog]]
- [[_COMMUNITY_Hermes Config & Auth|Hermes Config & Auth]]
- [[_COMMUNITY_Telegram Channel Delivery|Telegram Channel Delivery]]
- [[_COMMUNITY_FastAPI Routes|FastAPI Routes]]
- [[_COMMUNITY_UI Kit Command Palette|UI Kit: Command Palette]]
- [[_COMMUNITY_Supabase HTTP Client|Supabase HTTP Client]]
- [[_COMMUNITY_Web App Entry & Mock Data|Web App Entry & Mock Data]]
- [[_COMMUNITY_UI Kit Menubar|UI Kit: Menubar]]
- [[_COMMUNITY_Shared Dashboard Components|Shared Dashboard Components]]
- [[_COMMUNITY_UI Kit Dropdown Menu|UI Kit: Dropdown Menu]]
- [[_COMMUNITY_Accessibility & Medication Data (web)|Accessibility & Medication Data (web)]]
- [[_COMMUNITY_CLI REPL & Reply Formatting|CLI REPL & Reply Formatting]]
- [[_COMMUNITY_Rate Limiter (sliding window)|Rate Limiter (sliding window)]]
- [[_COMMUNITY_UI Kit Carousel|UI Kit: Carousel]]
- [[_COMMUNITY_UI Kit Form|UI Kit: Form]]
- [[_COMMUNITY_AI Insights Screen (web)|AI Insights Screen (web)]]
- [[_COMMUNITY_Vite Config & Provisioning|Vite Config & Provisioning]]
- [[_COMMUNITY_Elderly AI Voice Demo Screen|Elderly AI Voice Demo Screen]]
- [[_COMMUNITY_RLS Consent Integration Tests|RLS Consent Integration Tests]]
- [[_COMMUNITY_Voice Language Detection|Voice Language Detection]]
- [[_COMMUNITY_Web Package Metadata|Web Package Metadata]]
- [[_COMMUNITY_UI Kit Chart|UI Kit: Chart]]
- [[_COMMUNITY_UI Kit Drawer|UI Kit: Drawer]]
- [[_COMMUNITY_UI Kit Select|UI Kit: Select]]
- [[_COMMUNITY_Patient Screen & Edit Profile|Patient Screen & Edit Profile]]
- [[_COMMUNITY_UI Kit Navigation Menu|UI Kit: Navigation Menu]]
- [[_COMMUNITY_PDF Text Extraction|PDF Text Extraction]]
- [[_COMMUNITY_Voice STT (HuggingFace)|Voice STT (HuggingFace)]]
- [[_COMMUNITY_Accessibility Context (web)|Accessibility Context (web)]]
- [[_COMMUNITY_Language Detection Tests|Language Detection Tests]]
- [[_COMMUNITY_Add Prescription Sheet|Add Prescription Sheet]]
- [[_COMMUNITY_Web Dev Dependencies|Web Dev Dependencies]]
- [[_COMMUNITY_UI Kit Accordion|UI Kit: Accordion]]
- [[_COMMUNITY_UI Kit Alert|UI Kit: Alert]]
- [[_COMMUNITY_UI Kit Popover|UI Kit: Popover]]
- [[_COMMUNITY_Service-Client Guard Tests|Service-Client Guard Tests]]
- [[_COMMUNITY_UI Kit Toaster (sonner)|UI Kit: Toaster (sonner)]]
- [[_COMMUNITY_Medication Detail Card Screenshot|Medication Detail Card Screenshot]]
- [[_COMMUNITY_Deploy Watch-and-Push Script|Deploy Watch-and-Push Script]]
- [[_COMMUNITY_Deploy Watch-and-Push-Env Script|Deploy Watch-and-Push-Env Script]]
- [[_COMMUNITY_Deploy Sync-Env Script|Deploy Sync-Env Script]]
- [[_COMMUNITY_Deploy Watch-and-Pull Script|Deploy Watch-and-Pull Script]]
- [[_COMMUNITY_Hermes Package Init|Hermes Package Init]]
- [[_COMMUNITY_Medication Reminder Card Screenshot|Medication Reminder Card Screenshot]]
- [[_COMMUNITY_Hermes Module Root|Hermes Module Root]]
- [[_COMMUNITY_HTTP Async Client (misc)|HTTP Async Client (misc)]]

## God Nodes (most connected - your core abstractions)
1. `cn()` - 223 edges
2. `FakeDB` - 73 edges
3. `get_settings()` - 54 edges
4. `_ctx()` - 41 edges
5. `SessionRegistry` - 36 edges
6. `run_agent_turn()` - 32 edges
7. `FakeSupabase` - 30 edges
8. `FakeTelegram` - 25 edges
9. `Hermes orchestrator service` - 24 edges
10. `Supabase` - 21 edges

## Surprising Connections (you probably didn't know these)
- `Consent Model via care_links + RLS` --semantically_similar_to--> `care_links table`  [INFERRED] [semantically similar]
  supabase/README.md → docs/architecture.md
- `Claude Sonnet 5 (AI brain, per top-level README)` --conceptually_related_to--> `OpenAI gpt-4o (configured default brain)`  [AMBIGUOUS]
  README.md → services/hermes/README.md
- `AI system guidelines template (unfilled placeholder)` --references--> `apps/web — Vite+React frontend (from Figma)`  [INFERRED]
  apps/web/guidelines/Guidelines.md → README.md
- `apps/web index.html entry point (#root -> src/main.tsx)` --references--> `apps/web — Vite+React frontend (from Figma)`  [INFERRED]
  apps/web/index.html → README.md
- `Figma design (DOSEWISE project source)` --references--> `apps/web — Vite+React frontend (from Figma)`  [INFERRED]
  apps/web/README.md → README.md

## Import Cycles
- 1-file cycle: `services/hermes/src/hermes/tools/__init__.py -> services/hermes/src/hermes/tools/__init__.py`
- 1-file cycle: `apps/web/src/app/components/ui/input-otp.tsx -> apps/web/src/app/components/ui/input-otp.tsx`
- 1-file cycle: `apps/web/src/app/components/ui/sonner.tsx -> apps/web/src/app/components/ui/sonner.tsx`

## Hyperedges (group relationships)
- **Hermes tool belt (10-11 tools invoked from agent loop)** — services_hermes_readme_list_medications, services_hermes_readme_log_dose, services_hermes_readme_get_drug_info, services_hermes_readme_add_doctor_question, services_hermes_readme_message_caregiver, services_hermes_readme_show_instruction_video, services_hermes_readme_request_human_help, services_hermes_readme_add_prescription, services_hermes_readme_set_medication_reminder, services_hermes_readme_check_refills, services_hermes_readme_log_refill [EXTRACTED 1.00]
- **Propose-then-confirm safety pattern (human-in-the-loop)** — services_hermes_src_hermes_agent_soul_safety_rails, services_hermes_readme_add_prescription, services_hermes_src_hermes_agent_soul_update_medical_profile, services_hermes_readme_log_dose [INFERRED 0.85]
- **Multilingual voice pipeline (STT -> lang detect -> reply -> TTS)** — services_hermes_readme_multilingual_voice, services_hermes_readme_telegram_bot, services_hermes_readme_dialect_slang [INFERRED 0.80]
- **Hermes Tool Belt (constrained agent actions)** — docs_architecture_log_dose_tool, docs_architecture_list_medications_tool, docs_architecture_get_drug_info_tool, docs_architecture_add_doctor_question_tool, docs_architecture_message_caregiver_tool, docs_architecture_show_instruction_video_tool, docs_architecture_request_human_help_tool, docs_architecture_add_prescription_tool, services_hermes_readme_set_medication_reminder_tool, services_hermes_readme_check_refills_tool, services_hermes_readme_log_refill_tool [EXTRACTED 1.00]
- **Three Mutually Exclusive Hermes Deployment Paths** — docker_compose, hermes_deploy_readme, hermes_deploy_pm2_readme [EXTRACTED 1.00]

## Communities (70 total, 11 thin omitted)

### Community 0 - "Agent Turn Loop"
Cohesion: 0.06
Nodes (73): Run one turn. Returns (reply_text, tools_used, updated_messages)., run_agent_turn(), SessionRegistry, FakeAnthropic, FakeGemini, _FakeGeminiModels, FakeMessages, FakeOpenAI (+65 more)

### Community 1 - "Session State & Fake DB (tests)"
Cohesion: 0.07
Nodes (57): SessionState, FakeDB, _match_one(), A single PostgREST client double, backed by in-memory tables., Offline smoke tests: JWT identity claims and the scan-propose-confirm guard.  Th, _StubDB, _StubSupabase, test_add_prescription_proposes_then_commits() (+49 more)

### Community 2 - "UI Kit: Avatar/Breadcrumb"
Cohesion: 0.06
Nodes (42): Avatar(), AvatarFallback(), AvatarImage(), BreadcrumbEllipsis(), BreadcrumbItem(), BreadcrumbLink(), BreadcrumbList(), BreadcrumbPage() (+34 more)

### Community 3 - "Web Frontend Dependencies"
Cohesion: 0.04
Nodes (56): dependencies, canvas-confetti, class-variance-authority, clsx, cmdk, date-fns, embla-carousel-react, @emotion/react (+48 more)

### Community 4 - "Reminder Scheduler (cron)"
Cohesion: 0.07
Nodes (50): date, _alert_caregivers(), _elder_quiet_hours(), datetime, Reminder scheduler — the VPS cron that nudges elders about due medications.  Run, The elder's quiet-hours window from their first active care-link, or None., True if a dose of this medication was logged taken since local midnight., reminder_loop() (+42 more)

### Community 5 - "Web Frontend Provenance (Figma/shadcn)"
Cohesion: 0.05
Nodes (52): shadcn/ui component library, Unsplash photos, AI system guidelines template (unfilled placeholder), apps/web index.html entry point (#root -> src/main.tsx), DOSEWISE web code bundle, Figma design (DOSEWISE project source), apps/mobile — Expo+React Native frontend (deferred), apps/web — Vite+React frontend (from Figma) (+44 more)

### Community 6 - "UI Kit: Input/Separator/Sheet"
Cohesion: 0.05
Nodes (42): Input(), Separator(), Sheet(), SheetContent(), SheetDescription(), SheetFooter(), SheetHeader(), SheetOverlay() (+34 more)

### Community 7 - "App Settings & LLM Config"
Cohesion: 0.05
Nodes (29): ElderlyApp(), BaseSettings, aclose(), api_key_env_name(), api_key_present(), effective_provider(), make_client(), provider() (+21 more)

### Community 8 - "Dosewise Architecture & Deployment"
Cohesion: 0.05
Nodes (45): apps/mobile — Dosewise frontend (DEFERRED), Dual Interface (elder / caregiver views), docker-compose.yml (Hermes container), docker-compose.override.yml (dev auto-reload), Dosewise Architecture Doc, add_doctor_question() tool, add_prescription() tool, care_links table (+37 more)

### Community 9 - "Agent Loop Internals (dispatch/dialect)"
Cohesion: 0.07
Nodes (41): _anthropic_text(), _cached_system(), _cached_tools(), _dispatch_tool(), _elder_dialect(), _elder_slang(), _elder_voice_pref(), _gemini_content() (+33 more)

### Community 10 - "Tool Handler Framework"
Cohesion: 0.09
Nodes (26): get_handler(), Shared plumbing for tool handlers: the execution context and registry.  Each too, Everything a tool needs to act on the current elder's behalf., RLS-scoped PostgREST client acting as this elder., register(), ToolContext, message_caregiver(), Bridge to the caregiver: message_caregiver.  Records the message as a system con (+18 more)

### Community 11 - "UI Kit: Badge/Checkbox/OTP"
Cohesion: 0.07
Nodes (19): input-otp, Badge(), badgeVariants, Checkbox(), HoverCardContent(), InputOTP(), InputOTPGroup(), InputOTPSlot() (+11 more)

### Community 12 - "OpenFDA Drug Info Lookup"
Cohesion: 0.10
Nodes (30): _fetch_label(), get_drug_info(), _has_results(), interaction_text(), _openfda_get(), ToolContext, Grounded drug facts: get_drug_info (OpenFDA, cached in drug_cache)., Return an OpenFDA label payload for ``drug_name`` and where it came from.      C (+22 more)

### Community 13 - "UI Kit: Alert Dialog"
Cohesion: 0.10
Nodes (18): AlertDialogAction(), AlertDialogCancel(), AlertDialogContent(), AlertDialogDescription(), AlertDialogFooter(), AlertDialogHeader(), AlertDialogOverlay(), AlertDialogTitle() (+10 more)

### Community 14 - "Hermes Config & Auth"
Cohesion: 0.11
Nodes (19): RuntimeError, get_settings(), Runtime configuration for Hermes.  Loads from the repo-root ``.env`` (three leve, mint_user_jwt(), Supabase identity for Hermes.  Production forwards a Supabase-issued JWT from th, Sign a short-lived Supabase-compatible JWT that acts *as* ``elder_id``., Verify a client-supplied Supabase JWT (the real ``/agent/turn`` path).      Retu, verify_jwt() (+11 more)

### Community 15 - "Telegram Channel Delivery"
Cohesion: 0.19
Nodes (14): AsyncAnthropic, _deliver_reply(), _handle_callback(), handle_update(), poll_loop(), Telegram Bot API client + update dispatch.  Supports both delivery modes on one, Send the agent's reply out: text (with a Yes/No tap-keyboard when the agent, Render the medication timeline and, for the day view, attach ✅ Taken buttons (+6 more)

### Community 16 - "FastAPI Routes"
Cohesion: 0.13
Nodes (19): BaseModel, FastAPI, Request, agent_turn(), AgentTurnRequest, AgentTurnResponse, HTTP surface: health, the agent-turn contract, and the Telegram webhook., telegram_webhook() (+11 more)

### Community 17 - "UI Kit: Command Palette"
Cohesion: 0.12
Nodes (14): Command(), CommandGroup(), CommandInput(), CommandItem(), CommandList(), CommandSeparator(), CommandShortcut(), Dialog() (+6 more)

### Community 18 - "Supabase HTTP Client"
Cohesion: 0.15
Nodes (10): Any, AsyncClient, Response, _raise_for_status(), Owns the shared ``httpx.AsyncClient`` and hands out scoped clients., Upload bytes to a Storage bucket via the service role (bypasses Storage, A minimal PostgREST client bound to one set of auth headers., DELETE rows matching ``filters``. Under RLS this only removes rows the         c (+2 more)

### Community 19 - "Web App Entry & Mock Data"
Cohesion: 0.21
Nodes (10): MESSAGES, NOTIFICATIONS, PATIENTS, NAV_ITEMS, MessagesScreen(), NotificationsScreen(), OnboardingScreen(), AppMode (+2 more)

### Community 20 - "UI Kit: Menubar"
Cohesion: 0.12
Nodes (11): Menubar(), MenubarCheckboxItem(), MenubarContent(), MenubarItem(), MenubarLabel(), MenubarRadioItem(), MenubarSeparator(), MenubarShortcut() (+3 more)

### Community 21 - "Shared Dashboard Components"
Cohesion: 0.19
Nodes (10): Card(), PatientSwitcher(), QuickAction(), SectionHeader(), StatusPill(), DASH_DAYS, DashboardScreen(), SettingsScreen() (+2 more)

### Community 22 - "UI Kit: Dropdown Menu"
Cohesion: 0.12
Nodes (9): DropdownMenuCheckboxItem(), DropdownMenuContent(), DropdownMenuItem(), DropdownMenuLabel(), DropdownMenuRadioItem(), DropdownMenuSeparator(), DropdownMenuShortcut(), DropdownMenuSubContent() (+1 more)

### Community 23 - "Accessibility & Medication Data (web)"
Cohesion: 0.28
Nodes (10): useAccessibility(), ESTATUS, EYEDROP_STEPS, MED_PHOTOS, MED_PLAIN, MED_SHAPES, MED_SIMPLE, ElderlyHomeScreen() (+2 more)

### Community 24 - "CLI REPL & Reply Formatting"
Cohesion: 0.20
Nodes (12): main(), Terminal REPL harness — the fastest dev/debug loop.  Runs the same ``run_agent_t, _repl(), Outbound message formatting for the chat channels.  Telegram messages are sent a, Remove markdown emphasis/heading/code markers, preserving the text itself., strip_markdown(), Outbound markdown stripping (Item 7)., test_converts_star_bullets_to_dashes() (+4 more)

### Community 25 - "Rate Limiter (sliding window)"
Cohesion: 0.25
Nodes (13): Sliding-window counter keyed by an arbitrary string.      ``now`` is injectable, SlidingWindowLimiter, _client(), _make_app(), Rate-limiting: the sliding-window limiter, per-user turn caps on /agent/turn, th, test_agent_turn_per_user_cap_returns_429(), test_allows_up_to_limit_then_denies(), test_denied_tier_does_not_consume_other_tier() (+5 more)

### Community 26 - "UI Kit: Carousel"
Cohesion: 0.19
Nodes (13): Carousel(), CarouselApi, CarouselContent(), CarouselContext, CarouselContextProps, CarouselItem(), CarouselNext(), CarouselOptions (+5 more)

### Community 27 - "UI Kit: Form"
Cohesion: 0.20
Nodes (11): FormControl(), FormDescription(), FormFieldContext, FormFieldContextValue, FormItem(), FormItemContext, FormItemContextValue, FormLabel() (+3 more)

### Community 28 - "AI Insights Screen (web)"
Cohesion: 0.18
Nodes (8): MED_REASONS, WEEKLY_DATA, AIScreen(), SparkPoint, AskMeiScreen(), ChatMsg, caregiverAiRespond(), WeeklySummarySheet()

### Community 29 - "Vite Config & Provisioning"
Cohesion: 0.22
Nodes (10): Path, serve(), _create_users(), _insert_if_absent(), _load_env(), main(), AsyncClient, Read SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (env wins over repo .env). (+2 more)

### Community 30 - "Elderly AI Voice Demo Screen"
Cohesion: 0.28
Nodes (8): VOICE_DEMOS, aiRespond(), ElderlyAIScreen(), ElderlyNotificationsScreen(), DoctorQ, ElderlyTab, EMsg, Message

### Community 31 - "RLS Consent Integration Tests"
Cohesion: 0.15
Nodes (12): Automated RLS consent proof — the security-critical guarantee.  Encodes what the, Acting as Caregiver C, medications visible are Elder A's — never Elder B's., Explicitly querying Elder B's doses as Caregiver C returns nothing (RLS)., Elder A, acting as themselves, sees their own medications., Elder A explicitly querying Elder B's medications gets nothing (RLS)., The restrictive deny policies in migration 0004 mean an authenticated user     c, supabase(), test_caregiver_cannot_read_unlinked_elder_doses() (+4 more)

### Community 32 - "Voice Language Detection"
Cohesion: 0.18
Nodes (11): detect_language(), language_name(), _load_lid(), Language mapping + input-language detection for the voice pipeline.  Ties togeth, (engine, hint) for transcribing this elder. engine is ``"mms"`` (hint = the, The MMS-TTS model id for a language, or ``default`` when unsupported., A human-readable language name for the reply-language prompt hint., The fastText LID model, or None if disabled/unavailable (cached). (+3 more)

### Community 33 - "Web Package Metadata"
Cohesion: 0.18
Nodes (10): name, vite, pnpm, overrides, private, scripts, build, dev (+2 more)

### Community 34 - "UI Kit: Chart"
Cohesion: 0.22
Nodes (8): ChartConfig, ChartContainer(), ChartContext, ChartContextProps, ChartLegendContent(), ChartTooltipContent(), THEMES, useChart()

### Community 35 - "UI Kit: Drawer"
Cohesion: 0.18
Nodes (6): DrawerContent(), DrawerDescription(), DrawerFooter(), DrawerHeader(), DrawerOverlay(), DrawerTitle()

### Community 36 - "UI Kit: Select"
Cohesion: 0.18
Nodes (7): SelectContent(), SelectItem(), SelectLabel(), SelectScrollDownButton(), SelectScrollUpButton(), SelectSeparator(), SelectTrigger()

### Community 37 - "Patient Screen & Edit Profile"
Cohesion: 0.24
Nodes (9): MED_FREQUENCY, EditProfileSheet(), EditProfileSheetProps, GroupedMedication, groupMedications(), PatientScreen(), PatientScreenProps, Contact (+1 more)

### Community 38 - "UI Kit: Navigation Menu"
Cohesion: 0.22
Nodes (9): NavigationMenu(), NavigationMenuContent(), NavigationMenuIndicator(), NavigationMenuItem(), NavigationMenuLink(), NavigationMenuList(), NavigationMenuTrigger(), navigationMenuTriggerStyle (+1 more)

### Community 39 - "PDF Text Extraction"
Cohesion: 0.27
Nodes (8): extract_pdf_text(), Extract text from an uploaded PDF (prescription list / medical history).  Text-b, Return the text of a PDF, capped at ~20 pages / 8k chars. "" if none/failed., _one_page_pdf(), PDF text extraction (Item 2a)., test_extract_blank_pdf_is_empty_not_error(), test_extract_never_raises_on_truncated(), test_extract_returns_empty_on_garbage()

### Community 40 - "Voice STT (HuggingFace)"
Cohesion: 0.24
Nodes (9): _extract_text(), _hf_stt(), Voice for Telegram over the HuggingFace Inference API — speech-to-text and, opti, Whisper returns {"text": "..."}; some models return a list of chunks., One HF Inference STT call. With a language hint, use the JSON+parameters form, Transcribe an audio clip, or None if STT is unavailable.      ``engine="mms"`` r, Return spoken audio for ``text``, or None if TTS is unavailable/failed.      ``m, synthesize() (+1 more)

### Community 41 - "Accessibility Context (web)"
Cohesion: 0.28
Nodes (8): AccessibilityContext, AccessibilityContextValue, AccessibilityProvider(), AccessibilitySettings, DEFAULTS, FONT_SIZE_PX, FontSize, loadInitial()

### Community 43 - "Add Prescription Sheet"
Cohesion: 0.40
Nodes (5): MED_COLOURS, PRESET_TIMES, AddPrescriptionSheet(), AddPrescriptionSheetProps, Medication

### Community 44 - "Web Dev Dependencies"
Cohesion: 0.40
Nodes (5): devDependencies, tailwindcss, @tailwindcss/vite, vite, @vitejs/plugin-react

### Community 45 - "UI Kit: Accordion"
Cohesion: 0.40
Nodes (3): AccordionContent(), AccordionItem(), AccordionTrigger()

### Community 46 - "UI Kit: Alert"
Cohesion: 0.50
Nodes (4): Alert(), AlertDescription(), AlertTitle(), alertVariants

### Community 48 - "Service-Client Guard Tests"
Cohesion: 0.60
Nodes (4): _files_calling(), Structural guard: the RLS-bypassing service role must not sprawl.  ``service_cli, test_service_client_callers_are_allowlisted(), test_upload_object_callers_are_allowlisted()

### Community 51 - "Medication Detail Card Screenshot"
Cohesion: 0.67
Nodes (3): 'How to Take It' Numbered Instruction Steps, Medication Detail Card (Amlodipine) UI Screenshot, Supply Remaining / Refill Progress Bar Component

## Ambiguous Edges - Review These
- `Claude Sonnet 5 (AI brain, per top-level README)` → `OpenAI gpt-4o (configured default brain)`  [AMBIGUOUS]
  services/hermes/README.md · relation: conceptually_related_to

## Knowledge Gaps
- **134 isolated node(s):** `watch-and-pull.sh script`, `watch-and-push-env.sh script`, `CI Workflow (Hermes lint + tests)`, `docker-compose.override.yml (dev auto-reload)`, `profiles table` (+129 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **11 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Claude Sonnet 5 (AI brain, per top-level README)` and `OpenAI gpt-4o (configured default brain)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `cn()` connect `UI Kit: Avatar/Breadcrumb` to `UI Kit: Chart`, `UI Kit: Drawer`, `UI Kit: Select`, `UI Kit: Input/Separator/Sheet`, `UI Kit: Navigation Menu`, `UI Kit: Badge/Checkbox/OTP`, `UI Kit: Alert Dialog`, `UI Kit: Accordion`, `UI Kit: Alert`, `UI Kit: Popover`, `UI Kit: Command Palette`, `UI Kit: Menubar`, `UI Kit: Dropdown Menu`, `UI Kit: Carousel`, `UI Kit: Form`?**
  _High betweenness centrality (0.395) - this node is a cross-community bridge._
- **Why does `Settings` connect `App Settings & LLM Config` to `Vite Config & Provisioning`, `Hermes Config & Auth`?**
  _High betweenness centrality (0.198) - this node is a cross-community bridge._
- **Why does `ElderlyApp()` connect `App Settings & LLM Config` to `Web App Entry & Mock Data`, `Elderly AI Voice Demo Screen`?**
  _High betweenness centrality (0.196) - this node is a cross-community bridge._
- **Are the 9 inferred relationships involving `FakeDB` (e.g. with `test_loader_reads_and_caches_profile()` and `test_tick_alerts_caregiver_on_missed_critical()`) actually correct?**
  _`FakeDB` has 9 INFERRED edges - model-reasoned connections that need verification._
- **Are the 15 inferred relationships involving `get_settings()` (e.g. with `use_anthropic()` and `_use_gemini()`) actually correct?**
  _`get_settings()` has 15 INFERRED edges - model-reasoned connections that need verification._
- **Are the 2 inferred relationships involving `_ctx()` (e.g. with `SessionState` and `FakeSupabase`) actually correct?**
  _`_ctx()` has 2 INFERRED edges - model-reasoned connections that need verification._