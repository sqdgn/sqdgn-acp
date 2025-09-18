// Issue a buy job every 30 seconds
import AcpClient, {
  AcpAgentSort,
  AcpContractClient,
  AcpGraduationStatus,
  AcpJob,
  AcpJobPhases,
  AcpOnlineStatus,
} from "@virtuals-protocol/acp-node/dist/index.mjs";
import {
  BUYER_AGENT_WALLET_ADDRESS,
  BUYER_ENTITY_ID,
  TARGET_AGENT_WALLET_ADDRESS,
  WHITELISTED_WALLET_PRIVATE_KEY,
} from "./env.js";

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function main() {
  let cachedOffering: any | undefined;
  let cachedAgentInfo: { name?: string; walletAddress?: string } | undefined;
  const acpClient = new AcpClient({
    acpContractClient: await AcpContractClient.build(
      WHITELISTED_WALLET_PRIVATE_KEY,
      BUYER_ENTITY_ID,
      BUYER_AGENT_WALLET_ADDRESS
    ),
    onNewTask: async (job: AcpJob) => {
      if (
        job.phase === AcpJobPhases.NEGOTIATION &&
        job.memos.find((m) => m.nextPhase === AcpJobPhases.TRANSACTION)
      ) {
        console.log(`Paying job ${job.id}`);
        await job.pay(job.price);
        console.log(`Job ${job.id} paid`);
      } else if (job.phase === AcpJobPhases.COMPLETED) {
        console.log(`Job ${job.id} completed`);
      } else if (job.phase === AcpJobPhases.REJECTED) {
        console.log(`Job ${job.id} rejected`);
      }
    },
    onEvaluate: async (job: AcpJob) => {
      console.log(`Evaluation function called for job ${job.id}`);
      await job.evaluate(true, "Self-evaluated and approved");
      console.log(`Job ${job.id} evaluated`);
    },
  });

  while (true) {
    try {
      if (!cachedOffering) {
        const relevantAgents = await acpClient.browseAgents(
          "Degenerate Squid trade signals",
          {
            sort_by: [AcpAgentSort.SUCCESSFUL_JOB_COUNT],
            top_k: 10,
            graduationStatus: AcpGraduationStatus.ALL,
            onlineStatus: AcpOnlineStatus.ALL,
          }
        );

        const targetWallet = TARGET_AGENT_WALLET_ADDRESS?.toLowerCase();
        const chosenAgent =
          (targetWallet &&
            relevantAgents.find(
              (a) => a.walletAddress.toLowerCase() === targetWallet
            )) ||
          relevantAgents.find((a) => /degen(erate)?\s*squid/i.test(a.name));

        if (!chosenAgent) {
          console.warn("No matching agent found in browse results");
        } else if (!chosenAgent.offerings?.length) {
          console.warn("Chosen agent has no offerings");
        } else {
          cachedOffering = chosenAgent.offerings[0];
          cachedAgentInfo = {
            name: chosenAgent.name,
            walletAddress: chosenAgent.walletAddress,
          };
          console.log(
            `Selected agent ${cachedAgentInfo.name} (${cachedAgentInfo.walletAddress})`
          );
        }
      }

      if (cachedOffering) {
        const jobId = await cachedOffering.initiateJob(
          { signals: "Give me the last alpha siganls" },
          BUYER_AGENT_WALLET_ADDRESS,
          new Date(Date.now() + 1000 * 60 * 60 * 24)
        );
        console.log(
          `Job ${jobId} initiated` +
            (cachedAgentInfo
              ? ` for agent ${cachedAgentInfo.name} (${cachedAgentInfo.walletAddress})`
              : "")
        );
      }
    } catch (err: any) {
      console.error("Error issuing buy job:", err?.message ?? err);
      // If something goes wrong initiating jobs repeatedly, refresh selection next cycle
      if (!String(err?.message ?? "").includes("No matching agent")) {
        cachedOffering = undefined;
      }
    }

    await delay(30_000);
  }
}

main().catch((e) => {
  console.error("Fatal error in buyer-interval:", e);
});
