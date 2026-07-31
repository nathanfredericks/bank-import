import { useCallback, useEffect, useState, type FormEvent } from "react"
import {
  CheckCircle2,
  LoaderCircle,
  LockKeyhole,
  Mail,
  MessageSquare,
  ShieldAlert,
} from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"

type MfaOption = { id: string; label: string }
type Challenge = {
  bankDisplayName: string
  stage: string
  error?: string
  options?: MfaOption[]
}

const bankDisplayNames: Record<string, string> = {
  bmo: "BMO",
  "rogers-bank": "Rogers Bank",
  rogersbank: "Rogers Bank",
  nbdb: "NBDB",
  tangerine: "Tangerine",
}

function displayBankName(bank?: string) {
  if (!bank) return undefined
  return bankDisplayNames[bank.toLowerCase()] ?? bank
}

function csrfToken() {
  return document.cookie.match(/mfa_csrf=([^;]+)/)?.[1] ?? ""
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body
      ? { "content-type": "application/json", "x-csrf": csrfToken() }
      : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = (await response.json()) as T & { error?: string }
  if (!response.ok)
    throw new Error(data.error ?? "Unable to continue verification")
  return data
}

function optionIcon(option: MfaOption) {
  return option.id === "email" ? <Mail /> : <MessageSquare />
}

export function App() {
  const [challenge, setChallenge] = useState<Challenge | null>(null)
  const [code, setCode] = useState("")
  const [actionError, setActionError] = useState<string>()
  const [submitting, setSubmitting] = useState(false)
  const [unauthorized, setUnauthorized] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setChallenge(await api<Challenge>("/api/challenge"))
      setActionError(undefined)
      setUnauthorized(false)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to load verification"
      if (message === "unauthorized") {
        setUnauthorized(true)
        setActionError(undefined)
        return
      }
      setActionError(message)
    }
  }, [])

  useEffect(() => {
    if (unauthorized) return
    const initial = window.setTimeout(() => void refresh(), 0)
    const timer = window.setInterval(() => void refresh(), 1500)
    return () => {
      window.clearTimeout(initial)
      window.clearInterval(timer)
    }
  }, [refresh, unauthorized])

  async function chooseMethod(optionId: string) {
    setSubmitting(true)
    try {
      await api("/api/method", { optionId })
      await refresh()
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Unable to choose that method"
      )
    } finally {
      setSubmitting(false)
    }
  }

  async function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    try {
      await api("/api/code", { code })
      setCode("")
      await refresh()
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Unable to submit code"
      )
    } finally {
      setSubmitting(false)
    }
  }

  const stage = challenge?.stage ?? "preparing"
  const completed = stage === "completed"
  const failed = stage === "failed"
  const expired = stage === "timed_out" || stage === "cancelled"
  const bankDisplayName = displayBankName(challenge?.bankDisplayName)

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-5">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <span className="sr-only">Secure bank reconnect</span>
            <LockKeyhole
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
          </div>
          <CardTitle className="mt-5 text-2xl">
            {unauthorized
              ? "Reconnect Link Required"
              : completed
                ? "You’re Connected"
                : failed
                  ? "Unable to Continue"
                  : expired
                    ? "Reconnect Link Expired"
                    : "Continue Bank Login"}
          </CardTitle>
          <CardDescription>
            {unauthorized
              ? "Open the secure reconnect link sent to you to continue."
              : completed
                ? `Your ${bankDisplayName ?? "bank"} session has been refreshed and transactions are importing.`
                : failed
                  ? `The secure sign-in${bankDisplayName ? ` to ${bankDisplayName}` : ""} could not be completed.`
                  : expired
                    ? "Open the notification link again to start a fresh reconnect session."
                    : `Securely reconnect${bankDisplayName ? ` to ${bankDisplayName}` : ""}.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {unauthorized ? (
            <Alert>
              <LockKeyhole />
              <AlertTitle>Open Your Reconnect Link</AlertTitle>
              <AlertDescription>
                This page is available only through a time-limited link from a
                bank import notification.
              </AlertDescription>
            </Alert>
          ) : (
            <>
              {actionError && (
                <Alert variant="destructive">
                  <ShieldAlert />
                  <AlertTitle>Unable to Continue</AlertTitle>
                  <AlertDescription>{actionError}</AlertDescription>
                </Alert>
              )}

              {failed && (
                <Alert variant="destructive">
                  <ShieldAlert />
                  <AlertTitle>Verification Unavailable</AlertTitle>
                  <AlertDescription>
                    {challenge?.error ||
                      "The bank login could not be completed. Try again later."}
                  </AlertDescription>
                </Alert>
              )}

              {expired && (
                <Alert>
                  <ShieldAlert />
                  <AlertTitle>Reconnect Session Ended</AlertTitle>
                  <AlertDescription>
                    Reopen the original notification link to start a new secure
                    session.
                  </AlertDescription>
                </Alert>
              )}

              {!challenge ||
              stage === "awaiting_connection" ||
              stage === "starting_recovery" ||
              stage === "preparing" ? (
                <Alert>
                  <LoaderCircle className="animate-spin" />
                  <AlertTitle>Preparing Verification</AlertTitle>
                  <AlertDescription>
                    Your secure {bankDisplayName ?? "bank"} session is starting.
                  </AlertDescription>
                </Alert>
              ) : null}

              {stage === "awaiting_method" && (
                <section className="space-y-3">
                  <p className="text-sm font-medium">
                    Choose how to receive your{" "}
                    {bankDisplayName ? `${bankDisplayName} ` : ""}verification
                    code.
                  </p>
                  {challenge?.options?.map((option) => (
                    <Button
                      key={option.id}
                      variant="outline"
                      className="h-auto w-full justify-between rounded-2xl px-4 py-4"
                      disabled={submitting}
                      onClick={() => void chooseMethod(option.id)}
                    >
                      <span className="flex items-center gap-3">
                        {optionIcon(option)} {option.label}
                      </span>
                      <span aria-hidden="true">→</span>
                    </Button>
                  ))}
                </section>
              )}

              {stage === "awaiting_code" && (
                <form className="space-y-3" onSubmit={submitCode}>
                  <label className="grid gap-2 text-sm font-medium">
                    {bankDisplayName
                      ? `${bankDisplayName} Verification Code`
                      : "Verification Code"}
                    <Input
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      pattern="[0-9]*"
                      placeholder="Enter code"
                      value={code}
                      onChange={(event) =>
                        setCode(event.target.value.replace(/\D/g, ""))
                      }
                      required
                    />
                  </label>
                  <Button
                    className="w-full"
                    disabled={submitting || code.length < 4}
                    type="submit"
                  >
                    {submitting ? "Submitting…" : "Submit code"}
                  </Button>
                </form>
              )}

              {stage === "submitting_code" && (
                <Alert>
                  <LoaderCircle className="animate-spin" />
                  <AlertTitle>Checking Your Code</AlertTitle>
                  <AlertDescription>
                    Keep this page open while we finish the secure{" "}
                    {bankDisplayName ? `${bankDisplayName} ` : ""}sign-in.
                  </AlertDescription>
                </Alert>
              )}

              {completed && (
                <Alert>
                  <CheckCircle2 />
                  <AlertTitle>Verification Complete</AlertTitle>
                  <AlertDescription>
                    You can safely close this page.
                  </AlertDescription>
                </Alert>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </main>
  )
}

export default App
