// Work around package's default export quirk by importing ESM entry directly
import AcpClient, {
    AcpContractClient,
    AcpJobPhases,
    AcpJob,
    AcpMemo,
} from '@virtuals-protocol/acp-node/dist/index.mjs';
import {
    SELLER_AGENT_WALLET_ADDRESS,
    SELLER_ENTITY_ID,
    WHITELISTED_WALLET_PRIVATE_KEY,
    SQDGN_API_KEY
} from "./env.js";

const DEFAULT_MAX_CONCURRENCY = 3;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const SIGNAL_FETCH_MAX_ATTEMPTS = 3;
const SIGNAL_FETCH_BASE_DELAY_MS = 1_000;
const SIGNAL_API_URL = "https://api.sqdgn.ai/api/rest/signals?limit=5&chainType=evm";

function getNumericEnv(key: string, fallback: number): number {
    const raw = process.env[key];
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

type JobAction = "respond" | "deliver";

type JobHandler = (job: AcpJob, memo: AcpMemo | undefined, attempt: number) => Promise<void>;

interface JobProgress {
    responded: boolean;
    delivered: boolean;
}

interface QueueOptions {
    maxConcurrency: number;
    maxAttempts: number;
    baseRetryDelayMs: number;
}

interface JobTask {
    job: AcpJob;
    memo?: AcpMemo;
    action: JobAction;
    attempt: number;
    key: string;
}

const phaseLabel = (phase?: AcpJobPhases) =>
    phase === undefined ? "unknown" : AcpJobPhases[phase];

const queuePrefix = (jobId: number, action?: JobAction) =>
    `[queue][job:${jobId}${action ? `][${action}` : ""}]`;

function logQueue(jobId: number, action: JobAction | undefined, message: string) {
    console.log(`${queuePrefix(jobId, action)} ${message}`);
}

function logQueueError(jobId: number, action: JobAction, message: string) {
    console.error(`${queuePrefix(jobId, action)} ${message}`);
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchSignalsWithRetry(jobId: number): Promise<unknown> {
    for (let attempt = 1; attempt <= SIGNAL_FETCH_MAX_ATTEMPTS; attempt += 1) {
        const attemptInfo = attempt > 1 ? ` (retry ${attempt}/${SIGNAL_FETCH_MAX_ATTEMPTS})` : "";
        logQueue(jobId, "deliver", `Fetching signals${attemptInfo}`);

        try {
            const response = await fetch(
                SIGNAL_API_URL,
                {
                    method: "GET",
                    headers: {
                        accept: "application/json",
                        "X-Api-Key": SQDGN_API_KEY,
                    },
                }
            );

            if (!response.ok) {
                throw new Error(`Signal API returned ${response.status}`);
            }

            return response.json();
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            if (attempt >= SIGNAL_FETCH_MAX_ATTEMPTS) {
                logQueueError(jobId, "deliver", `Failed to fetch signals after ${attempt} attempts: ${errorMessage}`);
                throw err;
            }

            const delayMs = SIGNAL_FETCH_BASE_DELAY_MS * Math.pow(2, attempt - 1);
            logQueueError(
                jobId,
                "deliver",
                `Fetch attempt ${attempt} failed (${errorMessage}); retrying in ${delayMs}ms`
            );
            await delay(delayMs);
        }
    }

    throw new Error("Signal fetch retry loop exited unexpectedly");
}

// Lightweight in-memory queue to coordinate job actions
class SellerJobQueue {
    private pending: JobTask[] = [];
    private pendingByKey = new Map<string, JobTask>();
    private processing = new Map<string, JobTask>();
    private retryTasks = new Map<string, JobTask>();
    private retryTimers = new Map<string, NodeJS.Timeout>();
    private jobProgress = new Map<number, JobProgress>();

    constructor(
        private readonly handlers: Record<JobAction, JobHandler>,
        private readonly options: QueueOptions
    ) {}

    schedule(job: AcpJob, memo?: AcpMemo) {
        this.updateCompletionState(job);

        const nextPhase = memo?.nextPhase ?? job.latestMemo?.nextPhase;
        const action = this.determineAction(job, nextPhase);
        if (!action) {
            logQueue(
                job.id,
                undefined,
                `No action for phase ${phaseLabel(job.phase)} -> ${phaseLabel(nextPhase)} (memoId=${memo?.id ?? "none"})`
            );
            return;
        }

        const progress = this.getProgress(job.id);
        if ((action === "respond" && progress.responded) || (action === "deliver" && progress.delivered)) {
            logQueue(job.id, action, "Skipping duplicate event; action already completed");
            return;
        }

        const key = this.keyFor(job.id, action);

        if (this.processing.has(key)) {
            const taskInFlight = this.processing.get(key)!;
            taskInFlight.job = job;
            taskInFlight.memo = memo;
            logQueue(job.id, action, "Action already in-flight; refreshed job snapshot");
            return;
        }

        if (this.retryTasks.has(key)) {
            const retryTask = this.retryTasks.get(key)!;
            retryTask.job = job;
            retryTask.memo = memo;
            logQueue(job.id, action, "Action queued for retry; refreshed job snapshot");
            return;
        }

        const pendingTask = this.pendingByKey.get(key);
        if (pendingTask) {
            pendingTask.job = job;
            pendingTask.memo = memo;
            logQueue(job.id, action, "Action already pending; refreshed job snapshot");
            return;
        }

        const newTask: JobTask = {
            job,
            memo,
            action,
            attempt: 0,
            key,
        };

        this.pending.push(newTask);
        this.pendingByKey.set(key, newTask);
        logQueue(
            job.id,
            action,
            `Enqueued transition ${phaseLabel(job.phase)} -> ${phaseLabel(nextPhase)}; pending=${this.pending.length}, active=${this.processing.size}`
        );
        this.processQueue();
    }

    private processQueue() {
        if (this.processing.size >= this.options.maxConcurrency && this.pending.length > 0) {
            console.log(
                `[queue] Concurrency maxed (${this.processing.size}/${this.options.maxConcurrency}); backlog=${this.pending.length}`
            );
        }

        while (this.processing.size < this.options.maxConcurrency && this.pending.length > 0) {
            const task = this.pending.shift()!;
            this.pendingByKey.delete(task.key);
            this.startTask(task);
        }
    }

    private startTask(task: JobTask) {
        const attempt = task.attempt + 1;
        task.attempt = attempt;
        this.processing.set(task.key, task);

        logQueue(
            task.job.id,
            task.action,
            `Starting attempt ${attempt}; active=${this.processing.size}/${this.options.maxConcurrency}`
        );

        (async () => {
            try {
                await this.handlers[task.action](task.job, task.memo, attempt);
                this.handleSuccess(task);
            } catch (err) {
                this.handleFailure(task, err);
            } finally {
                this.processing.delete(task.key);
                this.processQueue();
            }
        })();
    }

    private handleSuccess(task: JobTask) {
        const progress = this.getProgress(task.job.id);
        if (task.action === "respond") {
            progress.responded = true;
        } else if (task.action === "deliver") {
            progress.delivered = true;
        }

        const retryTimer = this.retryTimers.get(task.key);
        if (retryTimer) {
            clearTimeout(retryTimer);
            this.retryTimers.delete(task.key);
            this.retryTasks.delete(task.key);
        }

        logQueue(
            task.job.id,
            task.action,
            `Completed attempt ${task.attempt}; pending=${this.pending.length}, retries=${this.retryTasks.size}`
        );
    }

    private handleFailure(task: JobTask, err: unknown) {
        const { maxAttempts, baseRetryDelayMs } = this.options;
        const errorMessage = err instanceof Error ? err.message : String(err);

        if (task.attempt >= maxAttempts) {
            logQueueError(
                task.job.id,
                task.action,
                `Failed after ${task.attempt} attempts: ${errorMessage}`
            );
            return;
        }

        const delay = baseRetryDelayMs * Math.pow(2, task.attempt - 1);
        logQueueError(
            task.job.id,
            task.action,
            `Attempt ${task.attempt} failed: ${errorMessage}. Retrying in ${delay}ms (pending=${this.pending.length}, retries=${this.retryTasks.size + 1})`
        );

        this.retryTasks.set(task.key, task);
        const timer = setTimeout(() => {
            this.retryTimers.delete(task.key);
            this.retryTasks.delete(task.key);
            this.pending.push(task);
            this.pendingByKey.set(task.key, task);
            logQueue(
                task.job.id,
                task.action,
                `Re-enqueued for attempt ${task.attempt + 1}; pending=${this.pending.length}`
            );
            this.processQueue();
        }, delay);

        this.retryTimers.set(task.key, timer);
    }

    private updateCompletionState(job: AcpJob) {
        if (
            job.phase === AcpJobPhases.COMPLETED ||
            job.phase === AcpJobPhases.REJECTED ||
            job.phase === AcpJobPhases.EXPIRED
        ) {
            logQueue(
                job.id,
                undefined,
                `Clearing queue state for terminal phase ${phaseLabel(job.phase)}`
            );
            this.jobProgress.delete(job.id);
            this.clearJobTasks(job.id);
        }
    }

    private clearJobTasks(jobId: number) {
        let removed = 0;
        this.pending = this.pending.filter((task) => {
            if (task.job.id === jobId) {
                this.pendingByKey.delete(task.key);
                removed += 1;
                return false;
            }
            return true;
        });

        for (const [key, task] of this.retryTasks.entries()) {
            if (task.job.id === jobId) {
                const timer = this.retryTimers.get(key);
                if (timer) {
                    clearTimeout(timer);
                    this.retryTimers.delete(key);
                }
                this.retryTasks.delete(key);
                removed += 1;
            }
        }

        if (removed > 0) {
            console.log(`[queue][job:${jobId}] Removed ${removed} queued tasks for terminal phase`);
        }
    }

    private determineAction(job: AcpJob, nextPhase?: AcpJobPhases): JobAction | undefined {
        if (job.phase === AcpJobPhases.REQUEST && nextPhase === AcpJobPhases.NEGOTIATION) {
            return "respond";
        }
        if (job.phase === AcpJobPhases.TRANSACTION && nextPhase === AcpJobPhases.EVALUATION) {
            return "deliver";
        }
        return undefined;
    }

    private getProgress(jobId: number): JobProgress {
        let progress = this.jobProgress.get(jobId);
        if (!progress) {
            progress = { responded: false, delivered: false };
            this.jobProgress.set(jobId, progress);
        }
        return progress;
    }

    private keyFor(jobId: number, action: JobAction) {
        return `${jobId}:${action}`;
    }
}

const queueOptions: QueueOptions = {
    maxConcurrency: getNumericEnv("SELLER_MAX_CONCURRENCY", DEFAULT_MAX_CONCURRENCY),
    maxAttempts: getNumericEnv("SELLER_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS),
    baseRetryDelayMs: getNumericEnv("SELLER_RETRY_DELAY_MS", DEFAULT_RETRY_DELAY_MS),
};

console.log(
    `[queue] Initialized with concurrency=${queueOptions.maxConcurrency}, maxAttempts=${queueOptions.maxAttempts}, baseRetryDelayMs=${queueOptions.baseRetryDelayMs}`
);

const queue = new SellerJobQueue(
    {
        respond: async (job, _memo, attempt) => {
            const attemptInfo = attempt > 1 ? ` (attempt ${attempt})` : "";
            console.log(`Responding to job ${job.id}${attemptInfo}`);
            logQueue(job.id, "respond", `Accepting job at price ${job.price}`);
            await job.respond(true);
            console.log(`Job ${job.id} responded`);
        },
        deliver: async (job, _memo, attempt) => {
            const attemptInfo = attempt > 1 ? ` (attempt ${attempt})` : "";
            console.log(`Delivering job ${job.id}${attemptInfo}`);

            const signals = await fetchSignalsWithRetry(job.id);
            const summary = Array.isArray(signals)
                ? `array length ${signals.length}`
                : signals && typeof signals === "object"
                    ? `keys=${Object.keys(signals).slice(0, 5).join(",")}`
                    : typeof signals;
            logQueue(job.id, "deliver", `Fetched signals payload summary: ${summary}`);
            await job.deliver(
                {
                    type: "object",
                    value: { signals },
                }
            );

            console.log(`Job ${job.id} delivered`);
        },
    },
    queueOptions
);

async function seller() {
    new AcpClient({
        acpContractClient: await AcpContractClient.build(
            WHITELISTED_WALLET_PRIVATE_KEY,
            SELLER_ENTITY_ID,
            SELLER_AGENT_WALLET_ADDRESS
        ),
        onNewTask: (job: AcpJob, memoToSign?: AcpMemo) => {
            queue.schedule(job, memoToSign);
        },
    });
}

seller();
