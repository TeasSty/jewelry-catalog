import gitGatewayPlugin from "workers-git-gateway";

interface Env {
  GH_ACCESS_TOKEN: string;
  GH_REPO: string;
}

export const onRequest: PagesFunction<Env> = (context) => {
  return gitGatewayPlugin({
    repo: context.env.GH_REPO,
    token: context.env.GH_ACCESS_TOKEN,
  })(context);
};
