import { z } from "zod";

const Transaction = z.object({
  date: z.string().date(),
  description: z.string(),
  amount: z.number(),
});

export const Account = z.object({
  id: z.string(),
  name: z.string(),
  balance: z.number(),
  transactions: z.array(Transaction),
});

export enum BankName {
  BMO = "bmo",
  Tangerine = "tangerine",
  ManulifeBank = "manulife-bank",
  RogersBank = "rogers-bank",
}
