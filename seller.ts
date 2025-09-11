// Work around package's default export quirk by importing ESM entry directly
import AcpClient, {
    AcpContractClient,
    AcpJobPhases,
    AcpJob,
} from '@virtuals-protocol/acp-node/dist/index.mjs';
import {
    SELLER_AGENT_WALLET_ADDRESS,
    SELLER_ENTITY_ID,
    WHITELISTED_WALLET_PRIVATE_KEY,
    SQDGN_API_KEY
} from "./env";

async function seller() {
    new AcpClient({
        acpContractClient: await AcpContractClient.build(
            WHITELISTED_WALLET_PRIVATE_KEY,
            SELLER_ENTITY_ID,
            SELLER_AGENT_WALLET_ADDRESS
        ),
        onNewTask: async (job: AcpJob) => {
            if (
                job.phase === AcpJobPhases.REQUEST &&
                job.memos.find((m) => m.nextPhase === AcpJobPhases.NEGOTIATION)
            ) {
                console.log(`Responding to job ${job.id}`);
                await job.respond(true);
                console.log(`Job ${job.id} responded`);
            } else if (
                job.phase === AcpJobPhases.TRANSACTION &&
                job.memos.find((m) => m.nextPhase === AcpJobPhases.EVALUATION)
            ) {
                console.log(`Delivering job ${job.id}`);

                const signals = await (await fetch(
                    "https://api.sqdgn.ai/api/rest/signals?limit=5&chainType=evm",
                    {
                        method: "GET",
                        headers: {
                            accept: "application/json",
                            "X-Api-Key": SQDGN_API_KEY,
                        },
                    }
                )).json();
                await job.deliver(
                    {
                        type: "object",
                        value: { signals },
                    }
                );

                console.log(`Job ${job.id} delivered`);
            }
        },
    });
}

seller();
