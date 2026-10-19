# Project machine

The Machine page shows the health of the virtual machine a project runs on. You reach it with the **Machine** button on the [project overview](project-overview.md), which project admins see.

![The Machine page, with services, Docker storage and resources](../../images/teams/teams-project-machine.png)

## Header

The project name above the title links back to the overview. **Refresh** reloads the page. Below the title, a line names the kind of machine and when it was last read, and notes that project admins can read the page and reset Docker storage. Logs are shown with secrets removed.

If the machine does not answer, a warning says so and explains that the installation restarts a project daemon that should be running.

## Services

One card per service. The screenshot shows **Container runtime (dockerd)**, **Forwarder**, **Project daemon** and **Task proxy**. Each card has a state badge (such as "Running") and a short detail line. Each can expand:

- **Recent log**, naming where the log comes from. It opens by itself when the service is not healthy.
- **Restart history**, for services that record restarts.

A **Restart** button appears on some services only for site administrators.

## Docker storage

Appears on machines of the virtual-machine kind. It explains that resetting Docker storage starts it clean when Docker keeps running out of memory or its disk is full, and warns that it deletes every image, container, volume and build cache on the machine and stops anything running in Docker. **Reset Docker storage…** starts the reset for project admins, after a confirmation. While a reset runs, the page refreshes itself and lists each step.

## Resources

Tiles showing CPU (cores and load), Memory (percent used, and used of total), and one tile per disk, such as **Container images and data** and **Project checkout**, with the percent used and the space free. A warning appears under the tiles when a resource is running short.

## Memory

Shows memory over time once the machine has been sampled a couple of times. The machine's size is changed by the installation's site admin.
