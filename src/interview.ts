import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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

  const answers: InterviewAnswer[] = [];
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index]!;
    const selected = await ctx.ui.select(formatQuestionTitle(index + 1, questions.length, question.question), questionOptions(question));
    if (!selected) break;
    if (selected === SKIP_OPTION) {
      answers.push({ questionId: question.id ?? `q${index + 1}`, question: question.question, answer: "Not sure", choiceLabel: selected, custom: false, recommended: false });
      continue;
    }
    if (selected === CUSTOM_OPTION) {
      const custom = await ctx.ui.input(compact(question.question, 72), "Type your answer...");
      if (!custom?.trim()) continue;
      answers.push({ questionId: question.id ?? `q${index + 1}`, question: question.question, answer: custom.trim(), custom: true, recommended: false });
      continue;
    }
    const choice = question.choices.find((candidate) => formatChoice(candidate, recommendedChoice(question)) === selected);
    const answer = choice?.value?.trim() || choice?.label.trim() || selected.replace(/\s*\(RECOMMENDED\)$/, "").trim();
    answers.push({
      questionId: question.id ?? `q${index + 1}`,
      question: question.question,
      answer,
      choiceLabel: choice?.label,
      custom: false,
      recommended: Boolean(choice?.recommended),
    });
  }

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
    `pi-chalin interview · ${result.status}`,
    `artifact: ${result.featureId}`,
    `reason: ${compact(result.reason, 140)}`,
    result.answers.length ? "answers:" : "answers: none",
    ...result.answers.map((answer, index) => `${index + 1}. ${compact(answer.question, 90)} → ${compact(answer.answer, 120)}${answer.custom ? " (custom)" : answer.recommended ? " (recommended)" : ""}`),
    result.status === "answered" ? "next: continue planning or call chalin_route with these answers as context." : "next: ask the user directly before running subagents.",
  ];
  return lines.join("\n");
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
