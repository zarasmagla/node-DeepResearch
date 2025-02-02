type BaseAction = {
  action: "search" | "answer" | "reflect" | "visit";
  thoughts: string;
};

export type SearchAction = BaseAction & {
  action: "search";
  searchQuery: string;
};

export type AnswerAction = BaseAction & {
  action: "answer";
  answer: string;
  references: Array<{
    exactQuote: string;
    url: string;
  }>;
};

export type ReflectAction = BaseAction & {
  action: "reflect";
  questionsToAnswer: string[];
};

export type VisitAction = BaseAction & {
  action: "visit";
  URLTargets: string[];
};

export type StepAction = SearchAction | AnswerAction | ReflectAction | VisitAction;