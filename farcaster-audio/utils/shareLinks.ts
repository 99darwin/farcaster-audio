import { Config } from "@/constants/config";

export const buildSpaceUrl = (roomId: string) =>
  `${Config.WEB_BASE_URL}/space/${roomId}`;

export const buildAppUrl = () => Config.WEB_BASE_URL;
