import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import {
  AccountsPage,
  DeviceStatusPage,
  OverviewPage,
} from "@/routes/dashboard";
import { OnboardingPage } from "@/routes/onboarding";
import { RootRouteComponent } from "@/routes/root";

const rootRoute = createRootRoute({
  component: RootRouteComponent,
  notFoundComponent: () => <Outlet />,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: OverviewPage,
});

const accountsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/accounts",
  component: AccountsPage,
});

const deviceStatusRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/device-status",
  component: DeviceStatusPage,
});

const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/onboarding",
  component: OnboardingPage,
});

const routeTree = rootRoute.addChildren([indexRoute, accountsRoute, deviceStatusRoute, onboardingRoute]);

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export function AppRouter() {
  return <RouterProvider router={router} />;
}
