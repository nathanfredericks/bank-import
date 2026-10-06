import { createHash } from "node:crypto";
import { v5 } from "uuid";
import { z } from "zod";
import { bankDate, EQ_ACCOUNTS, milliunits, type EQRecord } from "./types";
const BankAccounts = z.array(
  z
    .object({ accountNumber: z.string(), accountType: z.string().optional() })
    .passthrough(),
);
const Personal = z.object({
  Data: z.object({
    Transaction: z.array(
      z.object({
        TransactionId: z.string().min(1),
        Amount: z.object({ Amount: z.string(), Currency: z.literal("CAD") }),
        CreditDebitIndicator: z.enum(["Debit", "Credit"]),
        Status: z.literal("Booked"),
        BookingDateTime: z.string(),
        TransactionInformation: z.string(),
      }),
    ),
  }),
  Meta: z.object({ ListEnd: z.boolean() }),
});
const Card = z.object({
  page: z.number().int().positive(),
  pageCount: z.number().int().nonnegative(),
  transactions: z.array(
    z.object({
      transactionId: z.string().nullable(),
      status: z.enum(["PENDING", "POSTED"]),
      bookingDateTime: z.string(),
      valueDateTime: z.string(),
      transactionInformation: z.string(),
      auth_id: z.union([z.string(), z.number()]).nullable(),
      source_id: z.union([z.string(), z.number()]).nullable(),
      amount: z.object({ amount: z.string(), currencyCd: z.literal("CAD") }),
      chargeAmount: z
        .object({
          amount: z.string().nullable(),
          currencyCd: z.string().nullable(),
        })
        .nullable(),
    }),
  ),
});

export class EQHistory {
  constructor(
    private json: (
      path: string,
      headers?: Record<string, string>,
    ) => Promise<unknown>,
  ) {}
  async validateAccounts(namespace: string): Promise<void> {
    const accounts = BankAccounts.parse(
      await this.json("/accounts/v2/accounts"),
    );
    for (const [number, id] of Object.entries(EQ_ACCOUNTS)) {
      if (
        !accounts.some((a) => a.accountNumber === number) ||
        v5(number, namespace) !== id
      )
        throw new Error(
          "EQ account discovery did not match the configured identities",
        );
    }
  }
  async retrieve(start: string, namespace: string): Promise<EQRecord[]> {
    await this.validateAccounts(namespace);
    const end = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Halifax",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const [personal, card] = await Promise.all([
      this.personalHistory(start, end),
      this.cardHistory(start, end),
    ]);
    return [...personal, ...card];
  }
  async personalHistory(start: string, end: string): Promise<EQRecord[]> {
    const query = new URLSearchParams({
      fromBookingDate: start,
      toBookingDate: end,
    });
    const result = Personal.parse(
      await this.json(`/accounts/130742998/transactions?${query}`, {
        size: "1000",
      }),
    );
    if (!result.Meta.ListEnd || result.Data.Transaction.length >= 1000) {
      if (start === end)
        throw new Error(
          "EQ personal history remains truncated for one calendar day",
        );
      const mid = new Date(
        Math.floor((Date.parse(start) + Date.parse(end)) / 2),
      )
        .toISOString()
        .slice(0, 10);
      const next = new Date(Date.parse(mid) + 86400_000)
        .toISOString()
        .slice(0, 10);
      return [
        ...(await this.personalHistory(start, mid)),
        ...(await this.personalHistory(next, end)),
      ];
    }
    return result.Data.Transaction.map((row) => ({
      accountId: EQ_ACCOUNTS["130742998"],
      accountNumber: "130742998",
      bankId: row.TransactionId,
      provisionalId: row.TransactionId,
      references: [row.TransactionId],
      amount:
        milliunits(row.Amount.Amount) *
        (row.CreditDebitIndicator === "Debit" ? -1 : 1),
      date: bankDate(row.BookingDateTime),
      description: row.TransactionInformation,
      status: "posted" as const,
      originalAmount: null,
      originalCurrency: null,
    })).filter((row) => row.date >= start && row.date <= end);
  }
  async cardHistory(start: string, end: string): Promise<EQRecord[]> {
    const records: EQRecord[] = [];
    const occurrences = new Map<string, number>();
    let expectedPages: number | undefined;
    for (let page = 1; page <= (expectedPages ?? 1); page++) {
      const query = new URLSearchParams({
        startDate: start,
        endDate: end,
        limit: "100",
        offset: String(page),
      });
      const result = Card.parse(
        await this.json(`/transactions/v1.0.0/vs1/card-history?${query}`, {
          accountId: "302911525",
        }),
      );
      if (
        result.page !== page ||
        (expectedPages !== undefined && result.pageCount !== expectedPages) ||
        result.pageCount > 1000
      )
        throw new Error("EQ card pagination changed during retrieval");
      expectedPages = result.pageCount;
      if (page < expectedPages && result.transactions.length !== 100)
        throw new Error("EQ card pagination was incomplete");
      for (const row of result.transactions) {
        const date = bankDate(row.bookingDateTime || row.valueDateTime);
        if (date < start || date > end) continue;
        const seed = JSON.stringify([
          row.bookingDateTime,
          row.transactionInformation,
          row.chargeAmount,
          row.amount,
        ]);
        const occurrence = (occurrences.get(seed) ?? 0) + 1;
        occurrences.set(seed, occurrence);
        records.push({
          accountId: EQ_ACCOUNTS["302911525"],
          accountNumber: "302911525",
          bankId: row.transactionId,
          provisionalId: createHash("sha256")
            .update(`${seed}:${occurrence}`)
            .digest("hex"),
          references: [row.transactionId, row.auth_id, row.source_id]
            .filter((v) => v != null)
            .map(String),
          amount: milliunits(row.amount.amount),
          date,
          description: row.transactionInformation,
          status: row.status === "PENDING" ? "pending" : "posted",
          originalAmount: row.chargeAmount?.amount
            ? milliunits(row.chargeAmount.amount)
            : null,
          originalCurrency: row.chargeAmount?.currencyCd ?? null,
        });
      }
    }
    return records;
  }
}
