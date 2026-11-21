# oneM2M MEC IPE as a MEC application for the ETSI MEC Sandbox (image meep-docker-registry:30001/pb-onem2m-ipe).
# Build context is assembled by deploy/mec-sandbox/ipe/publish-image.sh: the IPE modules from
# pc-mobius/integration/src, the pod entry point and the lab CA certificate (public part only, from .local).
FROM node:22-alpine
WORKDIR /opt/pb-ipe
COPY package.json ./
COPY integration/src/ ./integration/src/
COPY scripts/run-mec-ipe-pod.mjs ./scripts/
COPY ca.pem /etc/pb-ipe/ca.pem
# Defaults; the scenario process `environment` sets MEC_MEP, MEC_SANDBOX_NAME, MEC_APP_INSTANCE_ID,
# MEC_CALLBACK_PUBLIC_URL, MEC_IPE_ONEM2M_URL and ONEM2M_CSE_URL per instance.
ENV NODE_ENV=production \
    MEC_BASE_URL=https://192.0.2.103 \
    MEC_CA_FILE=/etc/pb-ipe/ca.pem \
    MEC_LOCATION_VERSION=v3 \
    MEC_AMS_MEP=mep1 \
    ONEM2M_CSE_BASE=/Mobius \
    ONEM2M_CSE_ID=/pb-cse \
    MEC_IPE_ORIGINATOR=Cpb-mec-ipe \
    MEC_IPE_AE_NAME=pb-mec-ipe \
    MEC_IPE_REQUESTERS=Cguardian-app \
    MEC_IPE_READERS="Cguardian-app;Cpb-orchestrator" \
    MEC_IPE_ORCHESTRATORS=Cpb-orchestrator \
    MEC_IPE_LISTEN_HOST=0.0.0.0 \
    MEC_IPE_LISTEN_PORT=18080
USER node
EXPOSE 18080
ENTRYPOINT ["node", "scripts/run-mec-ipe-pod.mjs"]
