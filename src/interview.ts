import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, Key, matchesKey, truncateToWidth, type Component, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import type { ArtifactStore, InterviewDecisionInput } from "./artifacts.ts";

export interface InterviewChoiceInput {
  label: string;
  value?: string;
  recommended?: boolean;
}

export interface InterviewQuestionInput {
  id?: string;
  question: string;
  choices: InterviewChoiceInput[];
  allowCustom?: boolean;
}

export interface InterviewRequestInput {
  featureId?: string;
  task: string;
  reason: string;
  questions: InterviewQuestionInput[];
  batchSize?: number;
}

export interface InterviewAnswer {
  questionId: string;
  question: string;
  answer: string;
  choiceLabel?: string;
  custom: boolean;
  recommended: boolean;
}

export interface InterviewResult {
  featureId: string;
  task: string;
  reason: string;
  status: "answered" | "cancelled" | "non-interactive";
  answers: InterviewAnswer[];
  artifactCheckpoint?: string;
}

const CUSTOM_OPTION = "Custom answer…";
const SKIP_OPTION = "Skip / not sure";
const SUBMIT_INDEX_OFFSET = 1;

interface InterviewChoiceOption {
  label: string;
  value: string;
  choice?: InterviewChoiceInput;
  custom?: boolean;
  skip?: boolean;
  recommended?: boolean;
}

interface InterviewOverlayResult {
  answers: InterviewAnswer[];
  cancelled: boolean;
}

interface InterviewTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
}

export async function runChalinInterview(
  ctx: ExtensionContext,
  store: ArtifactStore,
  input: InterviewRequestInput,
): Promise<InterviewResult> {
  const featureId = safeFeatureId(input.featureId || input.task || input.reason || "interview");
  const questions = normalizeQuestions(input.questions, input.batchSize ?? 5);
  await store.initFeature({ featureId, goal: input.task, chain: ["interview"], currentStep: "Clarify request" });

  if (questions.length === 0) {
    const result: InterviewResult = { featureId, task: input.task, reason: input.reason, status: "cancelled", answers: [] };
    await persistInterview(store, result);
    return result;
  }

  if (!ctx.hasUI) {
    const result: InterviewResult = { featureId, task: input.task, reason: input.reason, status: "non-interactive", answers: [] };
    await persistInterview(store, result);
    ctx.ui.notify(formatInterviewRequest(input.task, input.reason, questions), "warning");
    return result;
  }

  const answers = typeof ctx.ui.custom === "function"
    ? await runBatchedInterview(ctx, questions)
    : await runSequentialInterview(ctx, questions);

  const result: InterviewResult = {
    featureId,
    task: input.task,
    reason: input.reason,
    status: answers.length === questions.length ? "answered" : "cancelled",
    answers,
  };
  const checkpoint = await persistInterview(store, result);
  result.artifactCheckpoint = checkpoint.id;
  return result;
}

export function formatInterviewResult(result: InterviewResult): string {
  const lines = [
    `chalin_interview ${result.status}`,
    `artifact: ${result.featureId}`,
    `reason: ${compact(result.reason, 120)}`,
    result.answers.length ? `answers (${result.answers.length}):` : "answers: none",
    ...result.answers.map((answer) => `- ${answer.questionId}: ${compact(answer.answer, 130)}${answer.custom ? " (custom)" : answer.recommended ? " (recommended)" : ""}`),
    result.status === "answered" ? "next: continue with these answers as planning context." : "next: ask the user directly before running subagents.",
  ];
  return lines.join("\n");
}

async function runBatchedInterview(ctx: ExtensionContext, questions: InterviewQuestionInput[]): Promise<InterviewAnswer[]> {
  const result = await ctx.ui.custom<InterviewOverlayResult>(
    (tui, theme, _keybindings, done) => new InterviewBatchOverlay(tui, theme as InterviewTheme, questions, done),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "94%",
        maxHeight: "88%",
        margin: 1,
      },
    },
  );
  return result.cancelled ? [] : result.answers;
}

async function runSequentialInterview(ctx: ExtensionContext, questions: InterviewQuestionInput[]): Promise<InterviewAnswer[]> {
  const answers: InterviewAnswer[] = [];
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index]!;
    const selected = await ctx.ui.select(formatQuestionTitle(index + 1, questions.length, question.question), questionOptions(question));
    if (!selected) break;
    const answer = await answerFromSelectedOption(ctx, question, index, selected);
    if (answer) answers.push(answer);
  }
  return answers;
}

async function answerFromSelectedOption(ctx: ExtensionContext, question: InterviewQuestionInput, index: number, selected: string): Promise<InterviewAnswer | undefined> {
  if (selected === SKIP_OPTION) {
    return { questionId: question.id ?? `q${index + 1}`, question: question.question, answer: "Not sure", choiceLabel: selected, custom: false, recommended: false };
  }
  if (selected === CUSTOM_OPTION) {
    const custom = await ctx.ui.input(compact(question.question, 72), "Type your answer...");
    if (!custom?.trim()) return undefined;
    return { questionId: question.id ?? `q${index + 1}`, question: question.question, answer: custom.trim(), custom: true, recommended: false };
  }
  const choice = question.choices.find((candidate) => formatChoice(candidate, recommendedChoice(question)) === selected);
  return answerFromChoice(question, index, {
    label: choice?.label ?? selected.replace(/\s*\(RECOMMENDED\)$/, "").trim(),
    value: choice?.value?.trim() || choice?.label.trim() || selected.replace(/\s*\(RECOMMENDED\)$/, "").trim(),
    choice,
    recommended: Boolean(choice?.recommended),
  });
}

function answerFromChoice(question: InterviewQuestionInput, index: number, option: InterviewChoiceOption): InterviewAnswer {
  const questionId = question.id ?? `q${index + 1}`;
  if (option.skip) {
    return { questionId, question: question.question, answer: "Not sure", choiceLabel: SKIP_OPTION, custom: false, recommended: false };
  }
  return {
    questionId,
    question: question.question,
    answer: option.value,
    choiceLabel: option.custom ? undefined : option.label,
    custom: Boolean(option.custom),
    recommended: Boolean(option.recommended),
  };
}

class InterviewBatchOverlay implements Component {
  private readonly editor: Editor;
  private readonly editorTheme: EditorTheme;
  private readonly optionIndexes: number[];
  private readonly answers = new Map<string, InterviewAnswer>();
  private focusIndex = 0;
  private inputQuestionIndex: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly theme: InterviewTheme,
    private readonly questions: InterviewQuestionInput[],
    private readonly done: (result: InterviewOverlayResult) => void,
  ) {
    this.optionIndexes = questions.map((question) => Math.max(0, questionOptionsForOverlay(question).findIndex((option) => option.recommended)));
    this.editorTheme = {
      borderColor: (text) => this.theme.fg("accent", text),
      selectList: {
        selectedPrefix: (text) => this.theme.fg("accent", text),
        selectedText: (text) => this.theme.fg("accent", text),
        description: (text) => this.theme.fg("muted", text),
        scrollInfo: (text) => this.theme.fg("dim", text),
        noMatch: (text) => this.theme.fg("warning", text),
      },
    };
    this.editor = new Editor(tui, this.editorTheme);
    this.editor.onSubmit = (value) => this.submitCustomAnswer(value);
  }

  render(width: number): string[] {
    if (this.cachedLines) return this.cachedLines;
    const safeWidth = Math.max(40, width);
    const lines: string[] = [];
    const add = (line = "") => lines.push(line ? truncateToWidth(line, safeWidth) : "");
    const answered = this.answers.size;
    const total = this.questions.length;

    add(this.theme.fg("accent", "chalin_interview"));
    add(this.theme.fg("muted", `${answered}/${total} answered · Tab changes question · Enter edits/chooses`));
    add(this.tabLine(safeWidth));
    add("");

    for (let index = 0; index < this.questions.length; index += 1) {
      const question = this.questions[index]!;
      const active = this.focusIndex === index;
      const answer = this.answers.get(question.id ?? `q${index + 1}`);
      const marker = active ? this.theme.fg("accent", ">") : " ";
      const status = answer ? this.theme.fg("success", "answered") : this.theme.fg("warning", "pending");
      add(`${marker} ${index + 1}. ${compact(question.question, Math.max(36, safeWidth - 18))} · ${status}`);
      add(`   ${this.theme.fg("muted", "answer:")} ${answer ? this.answerLabel(answer, safeWidth - 12) : this.theme.fg("dim", "not selected yet")}`);
      if (active) this.renderActiveQuestion(lines, safeWidth, question, index);
      if (index < this.questions.length - 1) add("");
    }

    add("");
    add(this.submitLine());
    add(this.theme.fg("dim", "Tab/←→ question · ↑↓ option · Enter choose/submit · Esc cancel"));
    this.cachedLines = lines;
    return lines;
  }

  handleInput(data: string): void {
    if (this.inputQuestionIndex !== undefined) {
      this.handleCustomInput(data);
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.done({ answers: this.orderedAnswers(), cancelled: true });
      return;
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
      this.moveFocus(1);
      return;
    }
    if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
      this.moveFocus(-1);
      return;
    }
    if (this.isSubmitFocused()) {
      if (matchesKey(data, Key.enter)) this.submitOrFocusMissing();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.moveOption(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.moveOption(1);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.chooseCurrentOption();
      return;
    }
    const numericChoice = Number(data);
    if (Number.isInteger(numericChoice) && numericChoice > 0) this.chooseOptionByNumber(numericChoice);
  }

  invalidate(): void {
    this.cachedLines = undefined;
  }

  private renderActiveQuestion(lines: string[], width: number, question: InterviewQuestionInput, questionIndex: number): void {
    const options = questionOptionsForOverlay(question);
    const selectedIndex = this.optionIndexes[questionIndex] ?? 0;
    for (let optionIndex = 0; optionIndex < options.length; optionIndex += 1) {
      const option = options[optionIndex]!;
      const selected = optionIndex === selectedIndex;
      const prefix = selected ? this.theme.fg("accent", "   > ") : "     ";
      const suffix = option.recommended ? this.theme.fg("muted", " (recommended)") : "";
      lines.push(truncateToWidth(`${prefix}${optionIndex + 1}. ${option.label}${suffix}`, width));
    }
    if (this.inputQuestionIndex === questionIndex) {
      lines.push("");
      lines.push(truncateToWidth(this.theme.fg("muted", "   custom answer:"), width));
      for (const line of this.editor.render(Math.max(24, width - 4))) {
        lines.push(truncateToWidth(`   ${line}`, width));
      }
    }
  }

  private handleCustomInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.inputQuestionIndex = undefined;
      this.editor.setText("");
      this.refresh();
      return;
    }
    this.editor.handleInput(data);
    this.refresh();
  }

  private submitCustomAnswer(value: string): void {
    const questionIndex = this.inputQuestionIndex;
    if (questionIndex === undefined) return;
    const trimmed = value.trim();
    if (!trimmed) {
      this.refresh();
      return;
    }
    const question = this.questions[questionIndex]!;
    this.answers.set(question.id ?? `q${questionIndex + 1}`, answerFromChoice(question, questionIndex, {
      label: trimmed,
      value: trimmed,
      custom: true,
    }));
    this.inputQuestionIndex = undefined;
    this.editor.setText("");
    this.advanceAfterAnswer(questionIndex);
  }

  private chooseCurrentOption(): void {
    const questionIndex = this.focusIndex;
    const question = this.questions[questionIndex];
    if (!question) return;
    const option = questionOptionsForOverlay(question)[this.optionIndexes[questionIndex] ?? 0];
    if (!option) return;
    if (option.custom) {
      this.inputQuestionIndex = questionIndex;
      this.editor.setText("");
      this.refresh();
      return;
    }
    this.answers.set(question.id ?? `q${questionIndex + 1}`, answerFromChoice(question, questionIndex, option));
    this.advanceAfterAnswer(questionIndex);
  }

  private chooseOptionByNumber(value: number): void {
    const question = this.questions[this.focusIndex];
    if (!question) return;
    const optionIndex = value - 1;
    if (optionIndex < 0 || optionIndex >= questionOptionsForOverlay(question).length) return;
    this.optionIndexes[this.focusIndex] = optionIndex;
    this.chooseCurrentOption();
  }

  private moveFocus(delta: number): void {
    const total = this.questions.length + SUBMIT_INDEX_OFFSET;
    this.focusIndex = (this.focusIndex + delta + total) % total;
    this.refresh();
  }

  private moveOption(delta: number): void {
    const question = this.questions[this.focusIndex];
    if (!question) return;
    const optionCount = questionOptionsForOverlay(question).length;
    const current = this.optionIndexes[this.focusIndex] ?? 0;
    this.optionIndexes[this.focusIndex] = Math.max(0, Math.min(optionCount - 1, current + delta));
    this.refresh();
  }

  private advanceAfterAnswer(questionIndex: number): void {
    const nextMissing = this.questions.findIndex((question, index) => index > questionIndex && !this.answers.has(question.id ?? `q${index + 1}`));
    if (nextMissing >= 0) this.focusIndex = nextMissing;
    else this.focusIndex = this.allAnswered() ? this.questions.length : this.firstMissingIndex();
    this.refresh();
  }

  private submitOrFocusMissing(): void {
    if (!this.allAnswered()) {
      this.focusIndex = this.firstMissingIndex();
      this.refresh();
      return;
    }
    this.done({ answers: this.orderedAnswers(), cancelled: false });
  }

  private isSubmitFocused(): boolean {
    return this.focusIndex === this.questions.length;
  }

  private allAnswered(): boolean {
    return this.answers.size === this.questions.length;
  }

  private firstMissingIndex(): number {
    const index = this.questions.findIndex((question, questionIndex) => !this.answers.has(question.id ?? `q${questionIndex + 1}`));
    return index >= 0 ? index : this.questions.length;
  }

  private orderedAnswers(): InterviewAnswer[] {
    return this.questions.flatMap((question, index) => {
      const answer = this.answers.get(question.id ?? `q${index + 1}`);
      return answer ? [answer] : [];
    });
  }

  private tabLine(width: number): string {
    const tabs = this.questions.map((question, index) => {
      const id = question.id ?? `q${index + 1}`;
      const answered = this.answers.has(id);
      const label = `${answered ? "x" : " "} ${compact(id, 14)}`;
      return this.focusIndex === index ? this.theme.bg("selectedBg", ` ${label} `) : this.theme.fg(answered ? "success" : "muted", ` ${label} `);
    });
    const submit = this.isSubmitFocused()
      ? this.theme.bg("selectedBg", " submit ")
      : this.theme.fg(this.allAnswered() ? "success" : "dim", " submit ");
    return truncateToWidth([...tabs, submit].join(" "), width);
  }

  private submitLine(): string {
    const label = this.allAnswered()
      ? "submit: ready, press Enter"
      : `submit: answer ${this.questions.length - this.answers.size} more`;
    return this.isSubmitFocused() ? this.theme.fg("accent", `> ${label}`) : this.theme.fg("muted", `  ${label}`);
  }

  private answerLabel(answer: InterviewAnswer, width: number): string {
    const suffix = answer.custom ? " (custom)" : answer.recommended ? " (recommended)" : "";
    return truncateToWidth(`${answer.answer}${suffix}`, Math.max(16, width));
  }

  private refresh(): void {
    this.cachedLines = undefined;
    this.tui.requestRender();
  }
}

function normalizeQuestions(raw: InterviewQuestionInput[], batchSize: number): InterviewQuestionInput[] {
  const max = Math.max(1, Math.min(5, Math.floor(batchSize || 5)));
  return raw
    .filter((question) => question.question.trim().length > 0)
    .slice(0, max)
    .map((question, index) => ({
      id: question.id?.trim() || `q${index + 1}`,
      question: compact(question.question, 160),
      allowCustom: question.allowCustom !== false,
      choices: normalizeChoices(question.choices),
    }));
}

function normalizeChoices(choices: InterviewChoiceInput[]): InterviewChoiceInput[] {
  const normalized = choices
    .filter((choice) => choice.label.trim().length > 0)
    .slice(0, 5)
    .map((choice) => ({ ...choice, label: compact(choice.label, 72), value: choice.value ? compact(choice.value, 180) : undefined }));
  if (normalized.some((choice) => choice.recommended)) return normalized;
  return normalized.map((choice, index) => ({ ...choice, recommended: index === 0 }));
}

function questionOptions(question: InterviewQuestionInput): string[] {
  const recommended = recommendedChoice(question);
  return [
    ...question.choices.map((choice) => formatChoice(choice, recommended)),
    ...(question.allowCustom === false ? [] : [CUSTOM_OPTION]),
    SKIP_OPTION,
  ];
}

function questionOptionsForOverlay(question: InterviewQuestionInput): InterviewChoiceOption[] {
  const recommended = recommendedChoice(question);
  return [
    ...question.choices.map((choice) => ({
      label: choice.label,
      value: choice.value?.trim() || choice.label.trim(),
      choice,
      recommended: choice === recommended || Boolean(choice.recommended),
    })),
    ...(question.allowCustom === false ? [] : [{ label: CUSTOM_OPTION, value: "", custom: true }]),
    { label: SKIP_OPTION, value: "Not sure", skip: true },
  ];
}

function recommendedChoice(question: InterviewQuestionInput): InterviewChoiceInput | undefined {
  return question.choices.find((choice) => choice.recommended) ?? question.choices[0];
}

function formatChoice(choice: InterviewChoiceInput, recommended: InterviewChoiceInput | undefined): string {
  const isRecommended = choice === recommended || choice.recommended;
  return `${choice.label}${isRecommended ? " (RECOMMENDED)" : ""}`;
}

function formatQuestionTitle(current: number, total: number, question: string): string {
  return `pi-chalin interview ${current}/${total} · ${compact(question, 70)}`;
}

function formatInterviewRequest(task: string, reason: string, questions: InterviewQuestionInput[]): string {
  return [
    "pi-chalin interview required",
    `task: ${compact(task, 140)}`,
    `reason: ${compact(reason, 140)}`,
    ...questions.map((question, index) => `${index + 1}. ${question.question}\n   ${question.choices.map((choice) => `- ${choice.label}${choice.recommended ? " (recommended)" : ""}`).join("\n   ")}`),
  ].join("\n");
}

async function persistInterview(store: ArtifactStore, result: InterviewResult) {
  const decision: InterviewDecisionInput = {
    task: result.task,
    reason: result.reason,
    answers: result.answers.map((answer) => ({
      questionId: answer.questionId,
      question: answer.question,
      answer: answer.answer,
      custom: answer.custom,
      recommended: answer.recommended,
    })),
    status: result.status,
  };
  await store.appendInterviewDecision(result.featureId, decision);
  return store.appendCheckpoint(result.featureId, {
    agent: "interview",
    title: result.status === "answered" ? "Interview answers captured" : "Interview needs user input",
    summary: result.answers.length ? result.answers.map((answer) => `${answer.question}: ${answer.answer}`).join("; ") : `No answers captured. ${result.reason}`,
    status: result.status === "answered" ? "active" : "paused",
    stage: "interview",
  });
}

function safeFeatureId(value: string): string {
  return compact(value, 80).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "interview";
}

function compact(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}
