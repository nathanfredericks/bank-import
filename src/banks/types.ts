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
  RogersBank = "rogers-bank",
  NBDB = "nbdb",
}

export const bankNames = {
  [BankName.BMO]: "BMO",
  [BankName.RogersBank]: "Rogers Bank",
  [BankName.NBDB]: "NBDB",
};
