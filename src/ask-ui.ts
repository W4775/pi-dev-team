export const OTHER_OPTION = "Other (type your own)";

export type AskQuestion = {
  id: string;
  question: string;
  options: string[];
  recommended?: number;
};

export type AskAnswer = {
  id: string;
  question: string;
  selected: string[];
  custom?: string;
};

type SelectUi = {
  hasUI?: boolean;
  ui?: {
    select?: (
      title: string,
      options: Array<string | { label: string; description?: string }>,
      options?: { signal?: AbortSignal },
    ) => Promise<string | undefined>;
    input?: (title: string, placeholder?: string, options?: { signal?: AbortSignal }) => Promise<string | undefined>;
    askDialog?: (
      questions: Array<{
        id: string;
        question: string;
        options: Array<{ label: string }>;
        recommended?: number;
      }>,
      options?: { signal?: AbortSignal },
    ) => Promise<
      | { kind: "submit"; results: Array<{ id: string; selectedOptions: string[]; customInput?: string }> }
      | { kind: "chat" }
      | undefined
    >;
  };
};

export function withOtherOption(options: string[]): string[] {
  const labels = options.map((option) => option.trim()).filter(Boolean);
  if (labels.some((label) => label.toLowerCase() === OTHER_OPTION.toLowerCase())) return labels;
  return [...labels, OTHER_OPTION];
}

export function formatAskAnswers(answers: AskAnswer[]): string {
  if (answers.length === 1) {
    const answer = answers[0];
    if (!answer) return "";
    return formatOneAnswer(answer);
  }
  return ["User answers:", ...answers.map((answer) => `${answer.id}: ${formatOneAnswer(answer)}`)].join("\n");
}

function formatOneAnswer(answer: AskAnswer): string {
  if (answer.custom?.trim()) return answer.custom.trim();
  return answer.selected.join(", ");
}

export async function promptQuestions(
  ctx: SelectUi,
  questions: AskQuestion[],
  opts?: { signal?: AbortSignal },
): Promise<AskAnswer[] | undefined> {
  if (!questions.length) return [];
  if (!ctx.hasUI || !ctx.ui) return undefined;

  const rich = ctx.ui.askDialog;
  if (typeof rich === "function") {
    const result = await rich(
      questions.map((question) => ({
        id: question.id,
        question: question.question,
        options: withOtherOption(question.options)
          .filter((label) => label !== OTHER_OPTION)
          .map((label) => ({ label })),
        recommended: question.recommended,
      })),
      { signal: opts?.signal },
    );
    if (!result || result.kind === "chat") return undefined;
    return questions.map((question) => {
      const hit = result.results.find((entry) => entry.id === question.id);
      const custom = hit?.customInput?.trim();
      return {
        id: question.id,
        question: question.question,
        selected: hit?.selectedOptions?.length ? hit.selectedOptions : custom ? [OTHER_OPTION] : [],
        custom: custom || undefined,
      };
    });
  }

  if (typeof ctx.ui.select !== "function") return undefined;

  const answers: AskAnswer[] = [];
  for (const question of questions) {
    const picked = await ctx.ui.select(question.question, withOtherOption(question.options), { signal: opts?.signal });
    if (picked == null) return undefined;
    if (picked === OTHER_OPTION) {
      const custom = await ctx.ui.input?.(question.question, "Your answer", { signal: opts?.signal });
      if (custom == null) return undefined;
      answers.push({ id: question.id, question: question.question, selected: [OTHER_OPTION], custom: custom.trim() });
      continue;
    }
    answers.push({ id: question.id, question: question.question, selected: [picked] });
  }
  return answers;
}
