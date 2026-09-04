import * as ynab from "ynab";
import { z } from "zod";
import { Account } from "./banks/types";

type BankAccount = z.infer<typeof Account>;
type Settings = {
  budgetId: string;
  adjustmentPayeeId?: string;
  dryRun: boolean;
  log: (message: string) => void;
};

export function createYnabImporter(api: ynab.API, settings: Settings) {
  async function matchedAccounts(accounts: BankAccount[]) {
    if (!accounts.length) throw new Error("Bank returned no accounts");
    const response = await api.accounts.getAccounts(settings.budgetId);
    const ynabAccounts = response.data.accounts.filter(
      (a) => !a.deleted && !a.closed,
    );
    // Validate every mapping before any writes, including accounts with no transactions.
    const candidates = accounts.map((account) => {
      const matches = ynabAccounts.filter((a) => a.note?.includes(account.id));
      settings.log(
        `Account ${account.id} (${account.name}): ${account.transactions.length} transactions; ${matches.length} YNAB mappings`,
      );
      return { account, matches };
    });
    if (candidates.some(({ matches }) => matches.length !== 1))
      throw new Error(
        "Expected exactly one YNAB mapping for each bank account",
      );
    const matched = candidates.map(({ account, matches }) => ({
      account,
      target: matches[0],
    }));
    if (new Set(matched.map((m) => m.target.id)).size !== matched.length)
      throw new Error("Multiple bank accounts map to one YNAB account");
    return matched;
  }

  return {
    async importTransactions(accounts: BankAccount[]) {
      const matched = await matchedAccounts(accounts);
      const occurrences: Record<string, number> = {};
      const now = new Date();
      const oldest = new Date();
      oldest.setFullYear(now.getFullYear() - 5);
      const transactions: ynab.SaveTransactionWithIdOrImportId[] =
        matched.flatMap(({ account, target }) =>
          account.transactions
            .filter((transaction) => {
              const date = new Date(transaction.date);
              return date <= now && date >= oldest;
            })
            .map((transaction) => {
              const amount = Math.round(transaction.amount * 1000);
              if (!Number.isSafeInteger(amount))
                throw new Error("Invalid transaction amount");
              const key = `${target.id}:${amount}:${transaction.date}`;
              occurrences[key] = (occurrences[key] ?? 0) + 1;
              return {
                account_id: target.id,
                date: transaction.date,
                amount,
                payee_name: transaction.description,
                cleared: ynab.TransactionClearedStatus.Cleared,
                import_id: `YNAB:${amount}:${transaction.date}:${occurrences[key]}`,
              };
            }),
        );
      settings.log(
        `${settings.dryRun ? "DRY RUN: would submit" : "Submitting"} ${transactions.length} Rogers transactions`,
      );
      if (!settings.dryRun && transactions.length) {
        const result = await api.transactions.createTransactions(
          settings.budgetId,
          { transactions },
        );
        settings.log(
          // YNAB also returns records updated by automatic matching, not just new entries.
          `YNAB processed ${transactions.length} submitted transactions; ${result.data.duplicate_import_ids?.length ?? 0} duplicate import IDs skipped`,
        );
      }
      return transactions;
    },

    async updateAccountBalances(accounts: BankAccount[]) {
      if (!settings.adjustmentPayeeId)
        throw new Error("NBDB adjustment payee is required");
      const { data } = await api.payees.getPayees(settings.budgetId);
      if (
        !data.payees.some(
          (p) =>
            !p.deleted &&
            !p.transfer_account_id &&
            p.id === settings.adjustmentPayeeId,
        )
      )
        throw new Error(
          "NBDB adjustment payee is not valid for the selected budget",
        );
      const matched = await matchedAccounts(accounts);
      const adjustments: ynab.SaveTransactionWithIdOrImportId[] =
        matched.flatMap(({ account, target }) => {
          const desired = Math.round(account.balance * 1000);
          const amount = desired - target.balance;
          if (!Number.isSafeInteger(desired) || !Number.isSafeInteger(amount))
            throw new Error("Invalid account balance");
          settings.log(
            `${settings.dryRun ? "DRY RUN: " : ""}NBDB account ${account.id}: adjustment ${amount} milliunits`,
          );
          return amount === 0
            ? []
            : [
                {
                  account_id: target.id,
                  payee_id: settings.adjustmentPayeeId,
                  date: new Date().toLocaleDateString("en-CA", {
                    timeZone: "America/Halifax",
                  }),
                  amount,
                  memo: "Entered automatically from NBDB",
                  cleared: ynab.TransactionClearedStatus.Reconciled,
                  approved: true,
                },
              ];
        });
      if (!settings.dryRun) {
        for (const transaction of adjustments)
          await api.transactions.createTransaction(settings.budgetId, {
            transaction,
          });
      }
      return adjustments;
    },
  };
}
